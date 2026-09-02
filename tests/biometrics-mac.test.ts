import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

// macOS biometric unlock has exactly one place a master password may be
// sealed to: a key in the biometry-gated keychain, which only a signed build
// can write. These tests pin the two policies around that: a build the
// keychain refuses gets no unlock rather than the old prompt-only scheme, and
// a blob written by that old scheme is either re-sealed or discarded, never
// kept as it is

const state = vi.hoisted(() => ({
    userData: '',
    keytar: new Map<string, string>(),
    touch: {
        loaded: true,
        usable: true,
        acceptWrites: true,
        readBehaviour: 'ok' as 'ok' | 'auth-failed' | 'canceled',
        secrets: new Map<string, Buffer>(),
    },
    hardwareUuid: '1234-ABCD' as string | null,
}));

vi.mock('electron', () => ({
    systemPreferences: { canPromptTouchID: () => true, promptTouchID: async () => {} },
    app: { getPath: () => state.userData },
}));

vi.mock('../electron/src/get-keytar', () => ({
    default: {
        getPassword: async (_s: string, account: string) => state.keytar.get(account) ?? null,
        setPassword: async (_s: string, account: string, value: string) => { state.keytar.set(account, value); },
        deletePassword: async (_s: string, account: string) => state.keytar.delete(account),
    },
}));

vi.mock('../electron/native/touchid', () => ({
    isLoaded: () => state.touch.loaded,
    availability: () => ({ usable: state.touch.usable, biometry: true, devicePasscode: true, biometryType: 'touch-id' }),
    setSecret: async (account: string, data: Buffer) => {
        if (!state.touch.acceptWrites) return { ok: false, code: 'missing-entitlement' };
        state.touch.secrets.set(account, Buffer.from(data));
        return { ok: true };
    },
    getSecret: async (account: string) => {
        if (state.touch.readBehaviour !== 'ok') return { ok: false, code: state.touch.readBehaviour };
        const data = state.touch.secrets.get(account);
        return data ? { ok: true, data } : { ok: false, code: 'not-found' };
    },
    deleteSecret: async (account: string) => { state.touch.secrets.delete(account); return { ok: true }; },
    hasSecret: async (account: string) => ({ ok: true, present: state.touch.secrets.has(account) }),
}));

vi.mock('child_process', () => ({
    execSync: () => {
        if (!state.hardwareUuid) throw new Error('system_profiler failed');
        return Buffer.from(`      Hardware UUID: ${state.hardwareUuid}\n`);
    },
}));

const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }));

state.userData = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'vigil-bio-'));
const SALT = 'ab'.repeat(32);
fs.writeFileSync(path.join(state.userData, '.salt'), SALT);

const bio = await import('../electron/src/biometrics');

const DB = '/Users/someone/vault.kdbx';
const ACCOUNT = `${DB}_${SALT}`;

// The blob format earlier versions wrote on macOS: AES-256-GCM under
// PBKDF2(hardware UUID, salt), no version prefix
function legacyBlob(password: string): string {
    const key = pbkdf2Sync('1234-ABCD', SALT, 100000, 32, 'sha512');
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

const secureBuild = () => { state.touch.acceptWrites = true; };
const unsignedBuild = () => { state.touch.acceptWrites = false; };

beforeEach(() => {
    bio.resetForTests();
    state.keytar.clear();
    state.touch.secrets.clear();
    state.touch.loaded = true;
    state.touch.usable = true;
    state.touch.readBehaviour = 'ok';
    state.hardwareUuid = '1234-ABCD';
    secureBuild();
});

describe('enabling biometric unlock on macOS', () => {
    it('seals the password under the keychain key on a signed build', async () => {
        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        expect(state.keytar.get(ACCOUNT)).toMatch(/^v3:/);
        expect(state.touch.secrets.has(ACCOUNT)).toBe(true);

        expect(await bio.hasBiometricsEnabled(DB)).toEqual({ success: true, enabled: true, hardwareBacked: true });
        expect(await bio.getBiometricPassword(DB)).toEqual({ success: true, password: 'hunter2' });
    });

    it('refuses on a build the keychain rejects, storing nothing', async () => {
        unsignedBuild();
        const result = await bio.enableBiometrics(DB, 'hunter2');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/signed build/);
        expect(state.keytar.size).toBe(0);

        const info = await bio.getBiometricsInfo();
        expect(info.available).toBe(false);
        expect(info.unavailableReason).toMatch(/signed build/);
    });

    it('refuses when the addon is not built, storing nothing', async () => {
        state.touch.loaded = false;
        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(false);
        expect(state.keytar.size).toBe(0);
    });

    it('fails outright when the keychain will not release the key it stored', async () => {
        // Used to fall through to the prompt-only scheme while the UI kept
        // reporting the unlock as hardware backed
        state.touch.readBehaviour = 'auth-failed';
        const result = await bio.enableBiometrics(DB, 'hunter2');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/did not release/);
        expect(state.keytar.size).toBe(0);
        expect(state.touch.secrets.has(ACCOUNT)).toBe(false);
    });

    it('reports a cancelled confirmation as such, storing nothing', async () => {
        state.touch.readBehaviour = 'canceled';
        const result = await bio.enableBiometrics(DB, 'hunter2');
        expect(result.error).toMatch(/cancelled/);
        expect(state.keytar.size).toBe(0);
    });

    it('reports the signed build as hardware backed', async () => {
        expect(await bio.getBiometricsInfo()).toEqual({ available: true, backend: 'hardware', biometryType: 'touch-id' });
    });
});

describe('a blob written by the old prompt-only scheme', () => {
    it('is re-sealed under the keychain by the first unlock on a signed build', async () => {
        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        expect(await bio.hasBiometricsEnabled(DB)).toEqual({ success: true, enabled: true, hardwareBacked: false });

        expect(await bio.getBiometricPassword(DB)).toEqual({ success: true, password: 'hunter2' });
        expect(state.keytar.get(ACCOUNT)).toMatch(/^v3:/);
        expect(state.touch.secrets.has(ACCOUNT)).toBe(true);
        expect(await bio.hasBiometricsEnabled(DB)).toEqual({ success: true, enabled: true, hardwareBacked: true });
    });

    it('is discarded by a build that cannot re-seal it', async () => {
        unsignedBuild();
        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        expect(await bio.hasBiometricsEnabled(DB)).toEqual({ success: true, enabled: false });
        expect(state.keytar.size).toBe(0);

        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        const result = await bio.getBiometricPassword(DB);
        expect(result.success).toBe(false);
        expect(result.retry).toBeFalsy();
        expect(result.error).toMatch(/turned off/);
        expect(state.keytar.size).toBe(0);
    });

    it('is discarded, not guessed at, when the hardware identifier is unavailable', async () => {
        // The old fallback derived the key from user name and host name
        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        state.hardwareUuid = null;
        const result = await bio.getBiometricPassword(DB);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/stale/);
        expect(state.keytar.size).toBe(0);
    });

    it('does not survive an unlock whose re-seal failed', async () => {
        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        // The probe passes, then the keychain refuses the real write
        const probe = await bio.getBiometricsInfo();
        expect(probe.available).toBe(true);
        state.touch.acceptWrites = false;

        expect(await bio.getBiometricPassword(DB)).toEqual({ success: true, password: 'hunter2' });
        expect(state.keytar.size).toBe(0);
    });
});

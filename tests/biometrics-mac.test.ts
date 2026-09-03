import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

// macOS biometric unlock has exactly one place a master password may be
// sealed to: a key in the biometry-gated keychain, which only a signed build
// can write. These tests pin the two policies around that: a build the
// keychain refuses gets no unlock rather than a weaker scheme, and a blob in
// any outdated format is discarded, never kept readable

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

        expect(await bio.hasBiometricsEnabled(DB)).toEqual({ success: true, enabled: true, armed: true });
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

describe('a blob in an outdated format', () => {
    it('is discarded at status check, never reported as enabled', async () => {
        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        expect(await bio.hasBiometricsEnabled(DB)).toEqual({ success: true, enabled: false });
        expect(state.keytar.size).toBe(0);
    });

    it('is discarded at unlock with a re-enable message, releasing nothing', async () => {
        state.keytar.set(ACCOUNT, legacyBlob('hunter2'));
        const result = await bio.getBiometricPassword(DB);
        expect(result.success).toBe(false);
        expect(result.password).toBeUndefined();
        expect(result.retry).toBeFalsy();
        expect(result.error).toMatch(/enable it again/);
        expect(state.keytar.size).toBe(0);
    });
});

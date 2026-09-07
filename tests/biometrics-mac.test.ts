import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

// macOS biometric unlock has exactly one place a master password may be
// sealed to: a key in the biometry-gated keychain, which only a signed build
// can write. These tests pin the policies around that: a build the keychain
// refuses gets no unlock rather than a weaker scheme, a blob in any outdated
// format is discarded rather than kept readable, and the sealed password is
// session-scoped by default, as on Windows, so nothing on disk releases it

const state = vi.hoisted(() => ({
    userData: '',
    keytar: new Map<string, string>(),
    touch: {
        loaded: true,
        usable: true,
        acceptWrites: true,
        readBehaviour: 'ok' as 'ok' | 'auth-failed' | 'canceled',
        secrets: new Map<string, Buffer>(),
        // Every Touch ID prompt the code asks for: releasing a key is the
        // only thing that raises one, so this counts them
        reads: 0,
    },
    hardwareUuid: '1234-ABCD' as string | null,
    // keytar does not guarantee findCredentials, and biometrics.ts guards for
    // its absence, so the tests can take it away
    keytarEnumerable: true,
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
        get findCredentials() {
            if (!state.keytarEnumerable) return undefined;
            return async () => [...state.keytar].map(([account, password]) => ({ account, password }));
        },
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
        state.touch.reads++;
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

const CONFIG = () => path.join(state.userData, 'biometrics-config.json');

// A restart, as the session mode sees one: the keychain and keytar survive,
// everything this process held in memory does not
const restart = () => bio.resetForTests();

// Persistence is opt-in now, so the tests that exercise it say so
async function persistentMode(): Promise<void> {
    await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
}

beforeEach(() => {
    bio.resetForTests();
    state.keytar.clear();
    state.touch.secrets.clear();
    state.touch.loaded = true;
    state.touch.usable = true;
    state.touch.readBehaviour = 'ok';
    state.touch.reads = 0;
    state.hardwareUuid = '1234-ABCD';
    state.keytarEnumerable = true;
    fs.rmSync(CONFIG(), { force: true });
    secureBuild();
});

describe('enabling biometric unlock on macOS', () => {
    it('seals the password under the keychain key on a signed build', async () => {
        await persistentMode();
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

describe('session-scoped mode on macOS (the default)', () => {
    it('is the default: nothing that opens the password is written to disk', async () => {
        expect(bio.getBiometricsConfig()).toEqual({ requirePasswordAfterRestart: true });
        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        // The only thing on disk is the intent marker
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');
        expect(state.touch.secrets.has(ACCOUNT)).toBe(true);
    });

    it('releases after a Touch ID read, and a restart disarms it', async () => {
        await bio.enableBiometrics(DB, 'hunter2');
        expect(state.touch.reads).toBe(1); // the enrolment read-back, which is the consent

        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: true });
        expect(await bio.getBiometricPassword(DB)).toEqual({ success: true, password: 'hunter2' });
        expect(state.touch.reads).toBe(2); // the release read

        restart();
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });
        const disarmed = await bio.getBiometricPassword(DB);
        expect(disarmed.success).toBe(false);
        expect(disarmed.password).toBeUndefined();
        expect(disarmed.retry).toBe(true); // the setup must survive
        expect(disarmed.error).toMatch(/Touch ID/);
    });

    // Unlike Windows, where the Hello signature IS the key and a re-arm cannot
    // avoid a prompt, the macOS wrapping key is generated locally. Prompting
    // anyway would decide nothing and only habituate the user to one more
    // Touch ID dialog right after they typed the master password
    it('re-arms after a restart without a second prompt', async () => {
        await bio.enableBiometrics(DB, 'hunter2');
        restart();

        const before = state.touch.reads;
        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        expect(state.touch.reads).toBe(before);
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: true });
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    // The arming key is regenerated every time, so a copy of the keychain item
    // taken before a restart opens nothing afterwards
    it('arms under a fresh wrapping key each time', async () => {
        await bio.enableBiometrics(DB, 'hunter2');
        const first = Buffer.from(state.touch.secrets.get(ACCOUNT)!);
        restart();
        await bio.enableBiometrics(DB, 'hunter2');
        expect(state.touch.secrets.get(ACCOUNT)).not.toEqual(first);
    });

    it('a dismissed Touch ID prompt releases nothing and keeps the setup', async () => {
        await bio.enableBiometrics(DB, 'hunter2');

        state.touch.readBehaviour = 'canceled';
        const result = await bio.getBiometricPassword(DB);
        expect(result).toMatchObject({ success: false, retry: true });
        expect(result.password).toBeUndefined();
        expect(result.error).toMatch(/cancelled/);

        state.touch.readBehaviour = 'ok';
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    it('a failed Touch ID check releases nothing and keeps the setup', async () => {
        await bio.enableBiometrics(DB, 'hunter2');

        state.touch.readBehaviour = 'auth-failed';
        expect(await bio.getBiometricPassword(DB)).toMatchObject({ success: false, retry: true });

        state.touch.readBehaviour = 'ok';
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    // BiometryCurrentSet: macOS drops the item when the enrolled fingerprints
    // change, so the session copy can never open again
    it('an enrolment change disarms the session copy instead of releasing it', async () => {
        await bio.enableBiometrics(DB, 'hunter2');

        state.touch.secrets.delete(ACCOUNT);
        const result = await bio.getBiometricPassword(DB);
        expect(result).toMatchObject({ success: false, retry: true });
        expect(result.password).toBeUndefined();
        // Still enrolled, just unarmed: the vault is not torn down
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });

        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    it('holds no plaintext password in memory between arming and release', async () => {
        const secret = 'correct horse battery staple ' + randomBytes(8).toString('hex');
        await bio.enableBiometrics(DB, secret);

        const retained = JSON.stringify(bio.sessionStateForTests(), (_key, value) =>
            Buffer.isBuffer(value) ? value.toString('base64') : value);
        expect(retained).not.toContain(secret);
        expect(retained).not.toContain(Buffer.from(secret).toString('base64'));
        expect(retained).not.toContain(Buffer.from(secret).toString('hex'));
        expect((await bio.getBiometricPassword(DB)).password).toBe(secret);
    });

    // Turning the setting on is a decision about every vault, including the
    // ones not opened for weeks: their v3 blobs are retired on the spot, along
    // with the keychain keys that sealed them, rather than left on disk for a
    // phished Touch ID prompt to open
    it('retires every pre-existing persistent blob when switched on', async () => {
        await persistentMode();
        await bio.enableBiometrics(DB, 'hunter2');
        const dormant = '/Users/someone/dormant.kdbx';
        const dormantAccount = `${dormant}_${SALT}`;
        await bio.enableBiometrics(dormant, 'sleepy');
        expect(state.keytar.get(ACCOUNT)).toMatch(/^v3:/);

        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');
        expect(state.keytar.get(dormantAccount)).toBe('v3-session:');
        // The wrapping keys go with the blobs they sealed, so a keychain
        // backup holding the old ciphertext cannot be opened either
        expect(state.touch.secrets.has(ACCOUNT)).toBe(false);
        expect(state.touch.secrets.has(dormantAccount)).toBe(false);

        const frozen = await bio.getBiometricPassword(DB);
        expect(frozen).toMatchObject({ success: false, retry: true });
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });

        await bio.enableBiometrics(DB, 'hunter2');
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    // A blob written by a version whose default was persistence, met by this
    // one under the new default: retired the first time anything looks
    it('retires persistent blobs from before the default changed', async () => {
        await persistentMode();
        await bio.enableBiometrics(DB, 'hunter2');

        // The config file goes, as for an install that never had one
        fs.rmSync(CONFIG());
        restart();
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');

        const disarmed = await bio.getBiometricPassword(DB);
        expect(disarmed).toMatchObject({ success: false, retry: true });
        expect(disarmed.password).toBeUndefined();

        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    // The sweep only covers what findCredentials reports, and macOS has no
    // shared value whose removal would invalidate a blob it missed, the way
    // dropping the DPAPI entropy does on Windows. So the blob has to go when
    // it is read, or the setting leaves exactly what it promises to remove:
    // a copy on disk that one Touch ID prompt opens
    it('retires a persistent blob the sweep cannot enumerate, at status check', async () => {
        await persistentMode();
        await bio.enableBiometrics(DB, 'hunter2');
        expect(state.keytar.get(ACCOUNT)?.startsWith('v3:')).toBe(true);

        fs.rmSync(CONFIG());
        restart();
        state.keytarEnumerable = false;

        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');
        expect(state.touch.secrets.has(ACCOUNT)).toBe(false);
    });

    it('retires a persistent blob the sweep cannot enumerate, at unlock', async () => {
        await persistentMode();
        await bio.enableBiometrics(DB, 'hunter2');

        fs.rmSync(CONFIG());
        restart();
        state.keytarEnumerable = false;

        const disarmed = await bio.getBiometricPassword(DB);
        expect(disarmed).toMatchObject({ success: false, retry: true });
        expect(disarmed.password).toBeUndefined();
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');
        expect(state.touch.secrets.has(ACCOUNT)).toBe(false);
    });

    it('turning the setting off re-seals armed vaults persistently', async () => {
        await bio.enableBiometrics(DB, 'hunter2');

        const before = state.touch.reads;
        await persistentMode();
        expect(state.keytar.get(ACCOUNT)).toMatch(/^v3:/);
        // One read opens the session copy and releases the key that seals the
        // persistent one
        expect(state.touch.reads).toBe(before + 1);

        // And it survives a restart, as persistence promises
        restart();
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    it('keeps a vault session-scoped when the re-seal prompt is refused', async () => {
        await bio.enableBiometrics(DB, 'hunter2');

        state.touch.readBehaviour = 'canceled';
        await persistentMode();
        expect(state.keytar.get(ACCOUNT)).toBe('v3-session:');

        state.touch.readBehaviour = 'ok';
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    it('disable clears the marker, the memory half and the keychain key', async () => {
        await bio.enableBiometrics(DB, 'hunter2');

        expect((await bio.disableBiometrics(DB)).success).toBe(true);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
        expect(state.touch.secrets.has(ACCOUNT)).toBe(false);
        const result = await bio.getBiometricPassword(DB);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No password found');
    });

    it('refuses to arm on a build the keychain rejects, storing nothing', async () => {
        unsignedBuild();
        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(false);
        expect(state.keytar.size).toBe(0);
        expect(bio.sessionStateForTests()).toEqual([]);
    });
});

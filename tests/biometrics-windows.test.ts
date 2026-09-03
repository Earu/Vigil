import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Windows Hello unlock, both trust models:
// - persistent (v4): blob in Credential Manager, key = HKDF(Hello signature,
//   salt = DPAPI-wrapped entropy). Survives restarts.
// - session-scoped ("require master password after restart"): keytar holds
//   only a marker, the password lives in process memory, a restart disarms
//   it until the next password unlock. Nothing on disk can release it.
// A vi.resetModules() plays the part of a restart: module state (the session
// map, config cache) dies, the keytar store and files survive.

const state = vi.hoisted(() => ({
    keytarStore: new Map<string, string>(),
    userData: `${process.env.TMPDIR || '/tmp'}/vigil-bio-test-${process.pid}`,
    verifyResult: 0, // Verified
    verifyCalls: [] as string[],
    signThrows: false,
}));

// Deterministic per (account, challenge), like the real RSA PKCS#1 v1.5 one
const fakeSignature = (accountId: string, challenge: Buffer): Buffer =>
    crypto.createHash('sha512').update(`sig:${accountId}:`).update(challenge).digest();

vi.mock('../electron/src/get-passport', () => ({
    VerificationResult: { Verified: 0, Canceled: 6 },
    Passport: class {
        constructor(public readonly id: string) {}
        get accountExists() { return true; }
        async createAccount() {}
        async sign(challenge: Buffer) {
            if (state.signThrows) throw new Error('Hello prompt dismissed');
            return fakeSignature(this.id, challenge);
        }
        async deleteAccount() {}
        static available() { return true; }
        static async requestVerification(message: string) {
            state.verifyCalls.push(message);
            return state.verifyResult;
        }
    },
}));

vi.mock('../electron/src/get-keytar', () => ({
    default: {
        getPassword: async (_s: string, account: string) => state.keytarStore.get(account) ?? null,
        setPassword: async (_s: string, account: string, value: string) => { state.keytarStore.set(account, value); },
        deletePassword: async (_s: string, account: string) => state.keytarStore.delete(account),
    },
}));

vi.mock('electron', () => ({
    app: { getPath: () => state.userData },
    systemPreferences: {},
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from('wrapped:' + s),
        decryptString: (b: Buffer) => {
            const text = b.toString();
            if (!text.startsWith('wrapped:')) throw new Error('not DPAPI-wrapped');
            return text.slice('wrapped:'.length);
        },
    },
}));

vi.mock('../electron/native/touchid', () => ({
    availability: () => ({ available: false, biometryType: 'none' }),
    getSecret: async () => ({ ok: false, code: 'unavailable' }),
    setSecret: async () => ({ ok: false, code: 'unavailable' }),
    deleteSecret: async () => {},
}));

Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
fs.mkdirSync(state.userData, { recursive: true });

const cryptoMod = await import('../electron/src/biometrics-crypto');

const DB = 'C:\\vaults\\test.kdbx';

// A restart: module state dies, disk and Credential Manager survive
const freshBiometrics = async () => {
    vi.resetModules();
    return await import('../electron/src/biometrics');
};

const keytarKeyFor = (dbPath: string): string => {
    const salt = fs.readFileSync(path.join(state.userData, '.salt'), 'utf8');
    return `${dbPath}_${salt}`;
};

beforeEach(() => {
    state.keytarStore.clear();
    state.verifyCalls.length = 0;
    state.verifyResult = 0;
    state.signThrows = false;
    for (const file of ['biometric-entropy.bin', 'biometrics-config.json']) {
        fs.rmSync(path.join(state.userData, file), { force: true });
    }
});

describe('persistent mode (v4)', () => {
    it('enables as a v4 blob and unlocks across a restart', async () => {
        let bio = await freshBiometrics();
        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        expect(cryptoMod.isV4Blob(state.keytarStore.get(keytarKeyFor(DB))!)).toBe(true);

        bio = await freshBiometrics();
        const result = await bio.getBiometricPassword(DB);
        expect(result).toMatchObject({ success: true, password: 'hunter2' });
        // The sign IS the Hello check; no separate verification prompt
        expect(state.verifyCalls).toEqual([]);
    });

    it('cannot open the blob without the DPAPI entropy', async () => {
        let bio = await freshBiometrics();
        await bio.enableBiometrics(DB, 'hunter2');

        fs.rmSync(path.join(state.userData, 'biometric-entropy.bin'), { force: true });
        bio = await freshBiometrics();
        const result = await bio.getBiometricPassword(DB);

        expect(result.success).toBe(false);
        expect(result.retry).toBeUndefined();
        // The blob is unrecoverable and gone; the user re-enables
        expect(state.keytarStore.has(keytarKeyFor(DB))).toBe(false);
    });

    it('a cancelled Hello prompt keeps the blob', async () => {
        const bio = await freshBiometrics();
        await bio.enableBiometrics(DB, 'hunter2');
        state.signThrows = true;
        const result = await bio.getBiometricPassword(DB);
        expect(result).toMatchObject({ success: false, retry: true });
        expect(state.keytarStore.has(keytarKeyFor(DB))).toBe(true);
    });

    it('discards a blob in an outdated format with a re-enable message', async () => {
        const bio = await freshBiometrics();
        // Force salt creation so the keytar key is computable
        await bio.hasBiometricsEnabled(DB);
        // A v2-era blob (Hello signature without the entropy salt), or
        // anything older: no compatibility reader, discard and re-enable
        state.keytarStore.set(keytarKeyFor(DB), 'v2:' + Buffer.from('whatever').toString('base64'));

        const result = await bio.getBiometricPassword(DB);
        expect(result.success).toBe(false);
        expect(result.password).toBeUndefined();
        expect(result.error).toMatch(/enable it again/);
        expect(state.keytarStore.has(keytarKeyFor(DB))).toBe(false);

        state.keytarStore.set(keytarKeyFor(DB), 'v2:' + Buffer.from('whatever').toString('base64'));
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: false });
        expect(state.keytarStore.has(keytarKeyFor(DB))).toBe(false);
    });
});

describe('session-scoped mode (require master password after restart)', () => {
    it('stores only the marker, releases after a verification, and a restart disarms it', async () => {
        let bio = await freshBiometrics();
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });

        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        // Nothing on disk but the intent marker
        expect(state.keytarStore.get(keytarKeyFor(DB))).toBe('v4-session:');
        expect(state.verifyCalls).toHaveLength(1); // the enable consent

        const unlocked = await bio.getBiometricPassword(DB);
        expect(unlocked).toMatchObject({ success: true, password: 'hunter2' });
        expect(state.verifyCalls).toHaveLength(2); // the release check

        // Restart: the memory half is gone, by design
        bio = await freshBiometrics();
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });
        const disarmed = await bio.getBiometricPassword(DB);
        expect(disarmed.success).toBe(false);
        expect(disarmed.retry).toBe(true); // the setup must survive

        // The password unlock re-arms without a prompt
        const before = state.verifyCalls.length;
        expect((await bio.enableBiometrics(DB, 'hunter2')).success).toBe(true);
        expect(state.verifyCalls).toHaveLength(before);
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: true });
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    it('a refused verification releases nothing and keeps the setup', async () => {
        const bio = await freshBiometrics();
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        await bio.enableBiometrics(DB, 'hunter2');

        state.verifyResult = 6; // Canceled
        const result = await bio.getBiometricPassword(DB);
        expect(result).toMatchObject({ success: false, retry: true });
        expect(result.password).toBeUndefined();
    });

    it('freezes a pre-existing persistent blob instead of releasing it', async () => {
        let bio = await freshBiometrics();
        await bio.enableBiometrics(DB, 'hunter2'); // persistent v4

        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        const frozen = await bio.getBiometricPassword(DB);
        expect(frozen).toMatchObject({ success: false, retry: true });
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false });

        // The re-arm replaces the blob with the marker: conversion complete
        await bio.enableBiometrics(DB, 'hunter2');
        expect(state.keytarStore.get(keytarKeyFor(DB))).toBe('v4-session:');
    });

    it('turning the setting off re-seals armed vaults persistently', async () => {
        let bio = await freshBiometrics();
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        await bio.enableBiometrics(DB, 'hunter2');

        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        expect(cryptoMod.isV4Blob(state.keytarStore.get(keytarKeyFor(DB))!)).toBe(true);

        // And it survives a restart, as persistence promises
        bio = await freshBiometrics();
        expect((await bio.getBiometricPassword(DB)).password).toBe('hunter2');
    });

    it('disable clears the marker and the memory half', async () => {
        const bio = await freshBiometrics();
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        await bio.enableBiometrics(DB, 'hunter2');

        expect((await bio.disableBiometrics(DB)).success).toBe(true);
        expect(state.keytarStore.has(keytarKeyFor(DB))).toBe(false);
        const result = await bio.getBiometricPassword(DB);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No password found');
    });
});

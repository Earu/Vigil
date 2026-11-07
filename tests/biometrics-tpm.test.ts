import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { generateKeyPairSync } from 'crypto';

const state = vi.hoisted(() => ({
    userData: '',
    keytar: new Map<string, string>(),
    tpm: {
        loaded: true,
        probe: { ok: true } as { ok: true } | { ok: false; code: string; status: number },
        objects: new Map<string, { name: string; data: Buffer; pin: string }>(),
        nextId: 0,
        failures: 0,
        lockoutAt: 32,
        lockout: { ok: true, lockoutAuthSet: true, maxTries: 32, recoveryInterval: 7200 } as Record<string, unknown>,
    },
    hello: { available: true, deleted: 0 },
}));

vi.mock('electron', () => ({
    app: { getPath: () => state.userData },
    systemPreferences: { canPromptTouchID: () => false },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from('wrapped:' + s),
        decryptString: (b: Buffer) => b.toString().slice('wrapped:'.length),
    },
}));

vi.mock('../electron/src/get-keytar', () => ({
    default: {
        getPassword: async (_s: string, account: string) => state.keytar.get(account) ?? null,
        setPassword: async (_s: string, account: string, value: string) => { state.keytar.set(account, value); },
        deletePassword: async (_s: string, account: string) => state.keytar.delete(account),
        findCredentials: async () => [...state.keytar].map(([account, password]) => ({ account, password })),
    },
}));

vi.mock('../electron/src/get-passport', () => ({
    VerificationResult: { Verified: 0 },
    Passport: class {
        constructor(public readonly id: string) {}
        get accountExists() { return true; }
        async createAccount() {}
        async sign(challenge: Buffer) { return Buffer.concat([Buffer.from(this.id), challenge]); }
        async deleteAccount() { state.hello.deleted++; }
        static available() { return state.hello.available; }
    },
}));

vi.mock('../electron/native/touchid', () => ({
    isLoaded: () => false,
    pinSupported: () => false,
    availability: () => ({ usable: false, biometry: false, devicePasscode: false, biometryType: 'none' }),
}));

vi.mock('../electron/native/tpm', () => ({
    isLoaded: () => state.tpm.loaded,
    probe: () => state.tpm.probe,
    seal: async (name: string, data: Buffer, pin: string) => {
        const id = `object-${state.tpm.nextId++}`;
        state.tpm.objects.set(id, { name, data: Buffer.from(data), pin });
        return { ok: true, sealed: Buffer.from(id) };
    },
    unseal: async (name: string, pin: string, sealed: Buffer) => {
        if (state.tpm.failures >= state.tpm.lockoutAt) return { ok: false, code: 'locked-out', status: 0x921 };
        const object = state.tpm.objects.get(sealed.toString());
        if (!object || object.name !== name) return { ok: false, code: 'not-found', status: 0x80090016 };
        if (object.pin !== pin) {
            state.tpm.failures++;
            return { ok: false, code: 'wrong-pin', status: 0x98e };
        }
        return { ok: true, data: Buffer.from(object.data) };
    },
    remove: async (name: string) => {
        for (const [id, object] of state.tpm.objects) if (object.name === name) state.tpm.objects.delete(id);
        return { ok: true, data: Buffer.alloc(0) };
    },
    lockout: async () => state.tpm.lockout,
}));

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });
setPlatform('linux');
afterAll(() => setPlatform(realPlatform));

state.userData = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'vigil-tpm-'));
const SALT = 'cd'.repeat(32);
fs.writeFileSync(path.join(state.userData, '.salt'), SALT);
const DEVICE = path.join(state.userData, 'tpmrm0');

const bio = await import('../electron/src/biometrics');
const { resetTpmForTests } = await import('../electron/src/biometrics-pin-tpm');

const DB = '/home/someone/vault.kdbx';
const ACCOUNT = `${DB}_${SALT}`;
const PIN = '482915';
const pinDir = () => path.join(state.userData, 'pin');
const enablePin = (pin = PIN) => bio.enableBiometrics(DB, 'hunter2', { method: 'pin', pin });
const restart = () => bio.resetForTests();

beforeEach(() => {
    setPlatform('linux');
    fs.rmSync(DEVICE, { force: true });
    fs.writeFileSync(DEVICE, '', { mode: 0o600 });
    resetTpmForTests(DEVICE);
    bio.resetForTests();
    state.keytar.clear();
    state.tpm.loaded = true;
    state.tpm.probe = { ok: true };
    state.tpm.objects.clear();
    state.tpm.failures = 0;
    state.tpm.lockoutAt = 32;
    state.tpm.lockout = { ok: true, lockoutAuthSet: true, maxTries: 32, recoveryInterval: 7200 };
    state.hello.available = true;
    state.hello.deleted = 0;
    fs.rmSync(pinDir(), { recursive: true, force: true });
    fs.rmSync(path.join(state.userData, 'biometrics-config.json'), { force: true });
    fs.rmSync(path.join(state.userData, 'tpm-pin-config.json'), { force: true });
});

describe('PIN unlock on Linux', () => {
    it('is the only method, and releases with the PIN', async () => {
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: true, methods: ['pin'] });
        expect(await enablePin()).toEqual({ success: true });
        expect(state.keytar.get(ACCOUNT)).toBe('pin1-session:');
        expect(await bio.getBiometricPassword(DB, PIN)).toEqual({ success: true, password: 'hunter2' });
    });

    it('keeps its state owner-only and free of the PIN and password', async () => {
        await enablePin();
        const [file] = fs.readdirSync(pinDir());
        const full = path.join(pinDir(), file);
        expect(fs.statSync(full).mode & 0o777).toBe(0o600);
        expect(fs.statSync(pinDir()).mode & 0o777).toBe(0o700);
        const content = fs.readFileSync(full, 'utf8');
        expect(content).not.toContain(PIN);
        expect(content).not.toContain('hunter2');
        expect(file).not.toContain('vault');
    });

    it('counts wrong PINs and turns off after five', async () => {
        await enablePin();
        expect((await bio.getBiometricPassword(DB, '000000')).error).toBe('Incorrect PIN, 4 attempts left');
        for (let i = 0; i < 3; i++) await bio.getBiometricPassword(DB, '000000');
        const lockedOut = await bio.getBiometricPassword(DB, '000000');
        expect(lockedOut.retry).toBeFalsy();
        expect(lockedOut.error).toMatch(/Too many incorrect PINs/);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
        expect(state.tpm.objects.size).toBe(0);
        expect(fs.readdirSync(pinDir())).toEqual([]);
    });

    it('a TPM lockout keeps the setup and spends none of the PIN attempts', async () => {
        await enablePin();
        state.tpm.lockoutAt = 0;
        const refused = await bio.getBiometricPassword(DB, PIN);
        expect(refused).toMatchObject({ success: false, retry: true });
        expect(refused.error).toMatch(/TPM is refusing attempts/);

        state.tpm.lockoutAt = 32;
        expect((await bio.getBiometricPassword(DB, '000000')).error).toBe('Incorrect PIN, 4 attempts left');
        expect((await bio.getBiometricPassword(DB, PIN)).password).toBe('hunter2');
    });

    it('re-arms after a restart from the master password alone', async () => {
        await enablePin();
        restart();
        expect(await bio.hasBiometricsEnabled(DB)).toMatchObject({ enabled: true, armed: false, method: 'pin' });
        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        expect((await bio.getBiometricPassword(DB, PIN)).password).toBe('hunter2');
    });

    it('persists when the restart lock is off', async () => {
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        await enablePin();
        expect(state.keytar.get(ACCOUNT)).toMatch(/^pin1:/);
        restart();
        expect((await bio.getBiometricPassword(DB, PIN)).password).toBe('hunter2');
    });

    it('a re-arm without the PIN never writes a persistent blob, even with the restart lock off', async () => {
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        await enablePin();
        state.keytar.set(ACCOUNT, 'pin1-session:');
        restart();
        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        expect(state.keytar.get(ACCOUNT)).toBe('pin1-session:');
        expect((await bio.getBiometricPassword(DB, PIN)).password).toBe('hunter2');
        expect(state.keytar.get(ACCOUNT)).toMatch(/^pin1:/);
    });

    it('a public key swapped in the state file never seals a password the attacker can open', async () => {
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        await enablePin();
        const [file] = fs.readdirSync(pinDir());
        const full = path.join(pinDir(), file);
        const attacker = generateKeyPairSync('x25519');
        const tampered = JSON.parse(fs.readFileSync(full, 'utf8'));
        tampered.publicKey = Buffer.from(attacker.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64');
        fs.writeFileSync(full, JSON.stringify(tampered));
        state.keytar.set(ACCOUNT, 'pin1-session:');
        restart();

        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        expect(state.keytar.get(ACCOUNT)).toBe('pin1-session:');

        const result = await bio.getBiometricPassword(DB, PIN);
        expect(result.success).toBe(false);
        expect(result.retry).toBeFalsy();
        expect(result.error).toMatch(/modified outside Vigil/);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
        expect(state.tpm.objects.size).toBe(0);
        expect(fs.readdirSync(pinDir())).toEqual([]);
    });

    it('a sealed object the TPM no longer opens takes the enrollment with it', async () => {
        await enablePin();
        state.tpm.objects.clear();
        const result = await bio.getBiometricPassword(DB, PIN);
        expect(result.retry).toBeFalsy();
        expect(result.error).toMatch(/reset/);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
    });

    it('disable removes the sealed object and the state', async () => {
        await enablePin();
        expect((await bio.disableBiometrics(DB)).success).toBe(true);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
        expect(state.tpm.objects.size).toBe(0);
        expect(fs.readdirSync(pinDir())).toEqual([]);
    });

    it('says how to get access when the TPM device is not readable', async () => {
        state.tpm.probe = { ok: false, code: 'unavailable', status: 0x0a000a };
        fs.chmodSync(DEVICE, 0o000);
        const info = await bio.getBiometricsInfo();
        expect(info.available).toBe(false);
        expect(info.unavailableReason).toMatch(/tss group/);
        expect((await enablePin()).error).toMatch(/tss group/);
        expect(state.keytar.size).toBe(0);
    });

    it('is not offered without a TPM device or without the addon', async () => {
        fs.rmSync(DEVICE);
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: false, methods: [] });

        fs.writeFileSync(DEVICE, '');
        bio.resetForTests();
        state.tpm.loaded = false;
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: false, methods: [] });
    });
});

describe('PIN unlock on Linux without TPM lockout protection', () => {
    const LONG_PIN = '4829150371';
    const unprotected = () => { state.tpm.lockout = { ok: true, lockoutAuthSet: false, maxTries: 32, recoveryInterval: 7200 }; };

    it('is refused, naming the command and the setting', async () => {
        unprotected();
        const info = await bio.getBiometricsInfo();
        expect(info).toMatchObject({ available: false, methods: [] });
        expect(info.unavailableReason).toMatch(/tpm2_changeauth -c lockout/);
        expect(info.unavailableReason).toMatch(/Settings/);
        expect((await enablePin()).error).toMatch(/tpm2_changeauth/);
        expect(state.tpm.objects.size).toBe(0);
        expect(await bio.getPinLockoutPolicy()).toEqual({ applies: true, protected: false, allowUnprotected: false });
    });

    it.each([
        ['too many tries', { maxTries: 1000, recoveryInterval: 7200 }],
        ['a fast recovery', { maxTries: 32, recoveryInterval: 60 }],
    ])('is refused with a lockout password but %s', async (_label, settings) => {
        state.tpm.lockout = { ok: true, lockoutAuthSet: true, ...settings };
        expect((await enablePin()).error).toMatch(/lockout password/);
    });

    it('treats unreadable lockout settings as unprotected', async () => {
        state.tpm.lockout = { ok: false, code: 'error', status: 0x18b };
        expect((await enablePin()).error).toMatch(/lockout password/);
    });

    it('accepts a recovery interval of zero, which never forgives a failure', async () => {
        state.tpm.lockout = { ok: true, lockoutAuthSet: true, maxTries: 32, recoveryInterval: 0 };
        expect(await enablePin()).toEqual({ success: true });
    });

    it('refuses to re-arm after a restart once the lockout password is gone', async () => {
        await enablePin();
        restart();
        unprotected();
        expect((await bio.enableBiometrics(DB, 'hunter2')).error).toMatch(/lockout password/);
    });

    it('with the opt-out, takes only a PIN of at least 10 digits', async () => {
        unprotected();
        expect((await bio.setAllowUnprotectedTpm(true)).success).toBe(true);
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: true, methods: ['pin'], pinMinLength: 10 });

        expect((await enablePin()).error).toBe('A PIN is 10 to 32 digits');
        expect(state.tpm.objects.size).toBe(0);

        expect(await enablePin(LONG_PIN)).toEqual({ success: true });
        expect((await bio.getBiometricPassword(DB, LONG_PIN)).password).toBe('hunter2');
    });

    it('keeps the opt-out across restarts until it is turned off', async () => {
        unprotected();
        await bio.setAllowUnprotectedTpm(true);
        restart();
        expect((await bio.getPinLockoutPolicy()).allowUnprotected).toBe(true);
        await bio.setAllowUnprotectedTpm(false);
        restart();
        expect((await enablePin(LONG_PIN)).error).toMatch(/lockout password/);
    });

    it('a protected TPM keeps the 6-digit minimum', async () => {
        expect(await bio.getBiometricsInfo()).toMatchObject({ pinMinLength: 6 });
        expect(await bio.getPinLockoutPolicy()).toEqual({ applies: true, protected: true, allowUnprotected: false });
    });
});

describe('PIN unlock on Windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('does not consult the lockout settings, which Windows owns', async () => {
        state.tpm.lockout = { ok: true, lockoutAuthSet: false, maxTries: 0xffffffff, recoveryInterval: 1 };
        expect((await bio.getBiometricsInfo()).methods).toContain('pin');
        expect(await enablePin()).toEqual({ success: true });
        expect((await bio.getPinLockoutPolicy()).applies).toBe(false);
    });

    it('is offered next to Windows Hello', async () => {
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: true, methods: ['windows-hello', 'pin'] });
    });

    it('is the only method when Hello is not set up', async () => {
        state.hello.available = false;
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: true, methods: ['pin'] });
    });

    it('is not offered when the TPM provider cannot be opened', async () => {
        state.tpm.probe = { ok: false, code: 'unavailable', status: 0x8028400f };
        expect((await bio.getBiometricsInfo()).methods).toEqual(['windows-hello']);
    });

    it('switching from Hello to PIN drops the Hello key, and the PIN unlocks', async () => {
        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        expect(state.keytar.get(ACCOUNT)).toBe('v4-session:');

        expect(await enablePin()).toEqual({ success: true });
        expect(state.hello.deleted).toBe(1);
        expect(state.keytar.get(ACCOUNT)).toBe('pin1-session:');
        expect([...state.tpm.objects.values()][0].name).toMatch(/^Vigil PIN [0-9a-f]{32}$/);
        expect(await bio.getBiometricPassword(DB, PIN)).toEqual({ success: true, password: 'hunter2' });
    });
});

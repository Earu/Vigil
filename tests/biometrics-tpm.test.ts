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
        objects: new Map<string, { name: string; data: Buffer; pin: string; forged?: boolean }>(),
        nextId: 0,
        failures: 0,
        lockoutAt: 32,
        failWith: null as { code: string; status: number } | null,
        lockout: { ok: true, lockoutAuthSet: true, maxTries: 32, recoveryInterval: 7200, lockoutRecovery: 86400 } as Record<string, unknown>,
        setLockoutCalls: [] as { auth: string; limits: { maxTries: number; recoveryInterval: number; lockoutRecovery: number } | null }[],
        setLockoutFails: false,
    },
    pkexec: {
        calls: [] as { file: string; args: string[] }[],
        exitCode: 0,
        grants: true,
        device: '',
        rule: '',
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
        if (object.forged) return { ok: false, code: 'tampered', status: 0xfffffffd };
        if (state.tpm.failWith) return { ok: false, ...state.tpm.failWith };
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
    lockout: async () => state.tpm.lockout.ok ? { ...state.tpm.lockout, failures: state.tpm.failures } : state.tpm.lockout,
    setLockout: async (auth: Buffer, limits: { maxTries: number; recoveryInterval: number; lockoutRecovery: number } | null) => {
        state.tpm.setLockoutCalls.push({ auth: auth.toString(), limits: limits ?? null });
        if (state.tpm.setLockoutFails) return { ok: false, code: 'error', status: 0x101 };
        state.tpm.lockout = { ...state.tpm.lockout, ...limits, lockoutAuthSet: true };
        return { ok: true, data: Buffer.alloc(0) };
    },
}));

vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('child_process')>(),
    execFile: (file: string, args: string[], callback: (error: (Error & { code?: number }) | null) => void) => {
        state.pkexec.calls.push({ file, args });
        if (state.pkexec.exitCode === 0 && state.pkexec.grants) {
            if (args[2].startsWith('rm ')) {
                fs.rmSync(state.pkexec.rule, { force: true });
                fs.chmodSync(state.pkexec.device, 0o000);
                state.tpm.probe = { ok: false, code: 'unavailable', status: 0x0a000a };
            } else {
                fs.writeFileSync(state.pkexec.rule, '');
                fs.chmodSync(state.pkexec.device, 0o600);
                state.tpm.probe = { ok: true };
            }
        }
        setImmediate(() => callback(state.pkexec.exitCode === 0 ? null : Object.assign(new Error('pkexec'), { code: state.pkexec.exitCode })));
    },
}));

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });
setPlatform('linux');
afterAll(() => setPlatform(realPlatform));

state.userData = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'vigil-tpm-'));
const SALT = 'cd'.repeat(32);
fs.writeFileSync(path.join(state.userData, '.salt'), SALT);
const DEVICE = path.join(state.userData, 'tpmrm0');
const PKEXEC = path.join(state.userData, 'pkexec');
const RULE = path.join(state.userData, '70-vigil-tpm.rules');
state.pkexec.device = DEVICE;
state.pkexec.rule = RULE;

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
    fs.writeFileSync(PKEXEC, '');
    fs.rmSync(RULE, { force: true });
    resetTpmForTests(DEVICE, [PKEXEC], RULE);
    state.tpm.setLockoutCalls = [];
    state.tpm.setLockoutFails = false;
    state.pkexec.calls = [];
    state.pkexec.exitCode = 0;
    state.pkexec.grants = true;
    bio.resetForTests();
    state.keytar.clear();
    state.tpm.loaded = true;
    state.tpm.probe = { ok: true };
    state.tpm.objects.clear();
    state.tpm.failures = 0;
    state.tpm.lockoutAt = 32;
    state.tpm.failWith = null;
    state.tpm.lockout = { ok: true, lockoutAuthSet: true, maxTries: 32, recoveryInterval: 7200, lockoutRecovery: 86400 };
    state.hello.available = true;
    state.hello.deleted = 0;
    fs.rmSync(pinDir(), { recursive: true, force: true });
    fs.rmSync(path.join(state.userData, 'biometrics-config.json'), { force: true });
    fs.rmSync(path.join(state.userData, 'tpm-pin-config.json'), { force: true });
});

describe('PIN unlock on Linux', () => {
    it('reports how many PINs the TPM lets an attacker try in a year', async () => {
        expect(await bio.getBiometricsInfo()).toMatchObject({ pinGuessesPerYear: 32 + 4380 });
        state.tpm.lockout = { ok: true, lockoutAuthSet: true, maxTries: 31, recoveryInterval: 600, lockoutRecovery: 86400 };
        expect(await bio.getBiometricsInfo()).toMatchObject({ pinGuessesPerYear: 31 + 52560 });
    });

    it('counts a guess a second when the TPM limits cannot be read', async () => {
        await bio.setAllowUnprotectedTpm(true);
        state.tpm.lockout = { ok: false, code: 'error', status: 0x101 };
        expect(await bio.getBiometricsInfo()).toMatchObject({ available: true, pinGuessesPerYear: 365 * 24 * 3600 });
    });

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

    it('counts a failure it does not recognise, since it may be a wrong PIN', async () => {
        await enablePin();
        state.tpm.failWith = { code: 'error', status: 0x80090010 };
        for (let i = 0; i < 4; i++) expect((await bio.getBiometricPassword(DB, '000000')).retry).toBe(true);
        const lockedOut = await bio.getBiometricPassword(DB, '000000');
        expect(lockedOut.retry).toBeFalsy();
        expect(lockedOut.error).toMatch(/Too many incorrect PINs/);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
    });

    it('an unreachable TPM spends none of the PIN attempts', async () => {
        await enablePin();
        state.tpm.failWith = { code: 'unavailable', status: 0x8028400f };
        for (let i = 0; i < 6; i++) expect((await bio.getBiometricPassword(DB, PIN)).retry).toBe(true);
        state.tpm.failWith = null;
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

    it('retiring a persistent blob leaves an old copy of it unopenable', async () => {
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        await enablePin();
        const copy = state.keytar.get(ACCOUNT)!;
        expect(copy).toMatch(/^pin1:/);

        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        expect(state.keytar.get(ACCOUNT)).toBe('pin1-session:');

        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        state.keytar.set(ACCOUNT, copy);
        const result = await bio.getBiometricPassword(DB, PIN);
        expect(result.success).toBe(false);
        expect(result.password).toBeUndefined();
    });

    it('keeps the PIN working after its blob is retired', async () => {
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        await enablePin();
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: true });
        restart();
        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        expect((await bio.getBiometricPassword(DB, PIN)).password).toBe('hunter2');
    });

    it('treats state without an epoch as malformed', async () => {
        await enablePin();
        const [file] = fs.readdirSync(pinDir());
        const full = path.join(pinDir(), file);
        const { epoch: _epoch, ...withoutEpoch } = JSON.parse(fs.readFileSync(full, 'utf8'));
        fs.writeFileSync(full, JSON.stringify(withoutEpoch));
        restart();
        expect((await bio.enableBiometrics(DB, 'hunter2')).error).toBe('Could not read the PIN setup');
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

    it('offers the setup when the TPM device is not readable', async () => {
        state.tpm.probe = { ok: false, code: 'unavailable', status: 0x0a000a };
        fs.chmodSync(DEVICE, 0o000);
        const info = await bio.getBiometricsInfo();
        expect(info.available).toBe(false);
        expect(info.unavailableReason).toMatch(/one-time setup on this computer/);
        expect((await enablePin()).error).toMatch(/one-time setup on this computer/);
        expect(await bio.getTpmSetupStep()).toBe('access');
        expect(state.keytar.size).toBe(0);
    });

    it('does not offer the setup for a readable TPM it cannot reach', async () => {
        state.tpm.probe = { ok: false, code: 'unavailable', status: 0x0a000a };
        expect(await bio.getTpmSetupStep()).toBe('unreachable');
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

    it('is refused, naming the setup and the setting', async () => {
        unprotected();
        const info = await bio.getBiometricsInfo();
        expect(info).toMatchObject({ available: false, methods: [] });
        expect(info.unavailableReason).toMatch(/one-time setup that limits wrong PIN guesses/);
        expect(info.unavailableReason).toMatch(/Settings/);
        expect((await enablePin()).error).toMatch(/wrong PIN guesses/);
        expect(await bio.getTpmSetupStep()).toBe('lockout');
        expect(state.tpm.objects.size).toBe(0);
        expect(await bio.getPinLockoutPolicy()).toEqual({ applies: true, protected: false, allowUnprotected: false });
    });

    it.each([
        ['too many tries', { maxTries: 1000, recoveryInterval: 7200 }],
        ['a fast recovery', { maxTries: 32, recoveryInterval: 60 }],
        ['a recovery time of zero, which turns the lockout off', { maxTries: 32, recoveryInterval: 0 }],
    ])('is refused with a lockout password but %s', async (_label, settings) => {
        state.tpm.lockout = { ok: true, lockoutAuthSet: true, ...settings };
        expect((await enablePin()).error).toMatch(/wrong PIN guesses/);
        expect(await bio.getTpmSetupStep()).toBe('foreign-lockout');
    });

    it('treats unreadable lockout settings as unprotected', async () => {
        state.tpm.lockout = { ok: false, code: 'error', status: 0x18b };
        expect((await enablePin()).error).toMatch(/wrong PIN guesses/);
        expect(await bio.getTpmSetupStep()).toBe('unreachable');
    });

    it('refuses to re-arm after a restart once the lockout password is gone', async () => {
        await enablePin();
        restart();
        unprotected();
        expect((await bio.enableBiometrics(DB, 'hunter2')).error).toMatch(/wrong PIN guesses/);
    });

    it('with the opt-out, takes only a PIN of at least 10 digits', async () => {
        unprotected();
        expect((await bio.setAllowUnprotectedTpm(true)).success).toBe(true);
        const info = await bio.getBiometricsInfo();
        expect(info).toMatchObject({ available: true, methods: ['pin'], pinMinLength: 10 });
        expect(info.pinGuessesPerYear).toBe(365 * 24 * 3600);

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
        expect((await enablePin(LONG_PIN)).error).toMatch(/wrong PIN guesses/);
    });

    it('a protected TPM keeps the 6-digit minimum', async () => {
        expect(await bio.getBiometricsInfo()).toMatchObject({ pinMinLength: 6 });
        expect(await bio.getPinLockoutPolicy()).toEqual({ applies: true, protected: true, allowUnprotected: false });
    });
});

describe('TPM setup on Linux', () => {
    const noAccess = () => {
        state.tpm.probe = { ok: false, code: 'unavailable', status: 0x0a000a };
        fs.chmodSync(DEVICE, 0o000);
    };
    const unprotected = (settings: Record<string, unknown> = {}) => {
        state.tpm.lockout = { ok: true, lockoutAuthSet: false, maxTries: 32, recoveryInterval: 7200, lockoutRecovery: 86400, ...settings };
    };
    const begin = async (acceptLimits = false) => {
        const result = await bio.beginTpmLockout(acceptLimits);
        if (!result.success) throw new Error(result.error);
        return result.password;
    };

    it('needs nothing on a protected TPM, and nothing off Linux', async () => {
        expect(await bio.getTpmSetupStep()).toBeNull();
        setPlatform('win32');
        noAccess();
        expect(await bio.getTpmSetupStep()).toBeNull();
    });

    it('grants access through pkexec with a fixed udev rule, then PIN unlock works', async () => {
        noAccess();
        expect(await bio.grantTpmAccess()).toEqual({ success: true });
        expect(state.pkexec.calls).toHaveLength(1);
        const [{ file, args }] = state.pkexec.calls;
        expect(file).toBe(PKEXEC);
        expect(args.slice(0, 2)).toEqual(['/bin/sh', '-c']);
        expect(args[2]).toContain(`'SUBSYSTEM=="tpmrm", KERNEL=="tpmrm[0-9]*", TAG+="uaccess"' > /etc/udev/rules.d/70-vigil-tpm.rules`);
        expect(await bio.getTpmSetupStep()).toBeNull();
        expect(await enablePin()).toEqual({ success: true });
    });

    it('does not run pkexec when access is already there', async () => {
        expect(await bio.grantTpmAccess()).toEqual({ success: true });
        expect(state.pkexec.calls).toHaveLength(0);
    });

    it('treats a dismissed password prompt as a cancel', async () => {
        noAccess();
        state.pkexec.exitCode = 126;
        expect(await bio.grantTpmAccess()).toMatchObject({ success: false, cancelled: true });
        expect(await bio.getTpmSetupStep()).toBe('access');
    });

    it.each([
        ['pkexec is missing', () => resetTpmForTests(DEVICE, [path.join(state.userData, 'missing')])],
        ['no password prompt could be shown', () => { state.pkexec.exitCode = 127; }],
        ['the change failed', () => { state.pkexec.exitCode = 1; }],
    ])('gives the commands to run when %s', async (_label, arrange) => {
        noAccess();
        arrange();
        const result = await bio.grantTpmAccess();
        expect(result).toMatchObject({ success: false });
        expect(result.success === false && result.commands?.[0]).toContain('/etc/udev/rules.d/70-vigil-tpm.rules');
    });

    it('says to log out and back in when the change took no effect', async () => {
        noAccess();
        state.pkexec.grants = false;
        const result = await bio.grantTpmAccess();
        expect(result).toMatchObject({ success: false });
        expect(result.success === false && result.error).toMatch(/Logging out and back in/);
    });

    it('removes the access it granted through pkexec, then asks for the setup again', async () => {
        noAccess();
        await bio.grantTpmAccess();
        expect(bio.tpmAccessGranted()).toBe(true);
        state.pkexec.calls = [];

        expect(await bio.revokeTpmAccess()).toEqual({ success: true });
        expect(state.pkexec.calls).toHaveLength(1);
        const [{ file, args }] = state.pkexec.calls;
        expect(file).toBe(PKEXEC);
        expect(args.slice(0, 2)).toEqual(['/bin/sh', '-c']);
        expect(args[2]).toMatch(/^rm -f \/etc\/udev\/rules\.d\/70-vigil-tpm\.rules && /);
        expect(args[2]).toContain('setfacl -x "u:$PKEXEC_UID"');
        expect(bio.tpmAccessGranted()).toBe(false);
        expect(await bio.getTpmSetupStep()).toBe('access');
    });

    it('does not run pkexec to remove access Vigil never granted', async () => {
        expect(bio.tpmAccessGranted()).toBe(false);
        expect(await bio.revokeTpmAccess()).toEqual({ success: true });
        expect(state.pkexec.calls).toHaveLength(0);
    });

    it('reports no granted access off Linux', () => {
        fs.writeFileSync(RULE, '');
        setPlatform('win32');
        expect(bio.tpmAccessGranted()).toBe(false);
    });

    it('keeps access when the password prompt for removing it is dismissed', async () => {
        fs.writeFileSync(RULE, '');
        state.pkexec.exitCode = 126;
        expect(await bio.revokeTpmAccess()).toMatchObject({ success: false, cancelled: true });
        expect(bio.tpmAccessGranted()).toBe(true);
    });

    it.each([
        ['pkexec is missing', () => resetTpmForTests(DEVICE, [path.join(state.userData, 'missing')])],
        ['the change failed', () => { state.pkexec.exitCode = 1; }],
    ])('gives the commands to remove access when %s', async (_label, arrange) => {
        fs.writeFileSync(RULE, '');
        arrange();
        const result = await bio.revokeTpmAccess();
        expect(result).toMatchObject({ success: false });
        expect(result.success === false && result.commands?.[0]).toBe('sudo rm /etc/udev/rules.d/70-vigil-tpm.rules');
    });

    it('says when apps can still use the chip after removing access', async () => {
        fs.writeFileSync(RULE, '');
        state.pkexec.grants = false;
        const result = await bio.revokeTpmAccess();
        expect(result).toMatchObject({ success: false });
        expect(result.success === false && result.error).toMatch(/Restarting the computer/);
    });

    it('sets the generated recovery password only once it is typed back', async () => {
        unprotected();
        const password = await begin();
        expect(password).toMatch(/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/);

        expect(await bio.applyTpmLockout('wrong-password')).toMatchObject({ success: false, mismatch: true });
        expect(state.tpm.setLockoutCalls).toHaveLength(0);

        expect(await bio.applyTpmLockout(`  ${password.toUpperCase()} `)).toEqual({ success: true });
        expect(state.tpm.setLockoutCalls).toEqual([{ auth: password, limits: null }]);
        expect(await bio.getTpmSetupStep()).toBeNull();
        expect(await bio.getPinLockoutPolicy()).toMatchObject({ protected: true });
        expect(await enablePin()).toEqual({ success: true });
    });

    it('generates a different password each time', async () => {
        unprotected();
        expect(await begin()).not.toBe(await begin());
    });

    it('keeps limits that are as strict or stricter, and only sets the password', async () => {
        unprotected({ maxTries: 3, recoveryInterval: 1000, lockoutRecovery: 1000 });
        expect(await bio.getTpmLockoutPlan()).toEqual({ success: true, change: null });
        await bio.applyTpmLockout(await begin());
        expect(state.tpm.setLockoutCalls[0].limits).toBeNull();
        expect(state.tpm.lockout).toMatchObject({ lockoutAuthSet: true, maxTries: 3, recoveryInterval: 1000, lockoutRecovery: 1000 });
    });

    it.each([
        ['too many tries', { maxTries: 1000, recoveryInterval: 1000 },
            { maxTries: { from: 1000, to: 32 } }, { maxTries: 32, recoveryInterval: 1000 }],
        ['a recovery too fast', { maxTries: 3, recoveryInterval: 60 },
            { recoveryInterval: { from: 60, to: 7200 } }, { maxTries: 3, recoveryInterval: 7200 }],
        ['protection turned off', { maxTries: 1000, recoveryInterval: 0 },
            { maxTries: { from: 1000, to: 32 }, recoveryInterval: { from: 0, to: 7200 } }, { maxTries: 32, recoveryInterval: 7200 }],
    ])('changes only the loose limits, with consent, for %s', async (_label, settings, change, limits) => {
        unprotected({ ...settings, lockoutRecovery: 1000 });
        expect(await bio.getTpmLockoutPlan()).toEqual({ success: true, change });
        expect(await bio.beginTpmLockout(false)).toMatchObject({ success: false });

        expect(await bio.applyTpmLockout(await begin(true))).toEqual({ success: true });
        expect(state.tpm.setLockoutCalls[0].limits).toEqual({ ...limits, lockoutRecovery: 1000 });
    });

    it('starts over when the limits change after consent', async () => {
        unprotected({ maxTries: 1000 });
        const password = await begin(true);
        unprotected({ maxTries: 2000 });
        expect(await bio.applyTpmLockout(password)).toMatchObject({ success: false });
        expect(state.tpm.setLockoutCalls).toHaveLength(0);
    });

    it.each([0, 1])('refuses PIN unlock and changes nothing when the TPM allows %i tries', async (maxTries) => {
        unprotected({ maxTries });
        expect(await bio.getTpmSetupStep()).toBe('too-few-tries');
        expect((await bio.getBiometricsInfo()).unavailableReason).toMatch(/fewer than 2 wrong PINs/);
        expect(await bio.beginTpmLockout(true)).toMatchObject({ success: false });

        state.tpm.lockout = { ...state.tpm.lockout, lockoutAuthSet: true };
        await bio.setAllowUnprotectedTpm(true);
        expect((await enablePin('4829150371')).error).toMatch(/fewer than 2 wrong PINs/);
        expect(state.tpm.setLockoutCalls).toHaveLength(0);
    });

    it('spends no TPM try on setup', async () => {
        expect(await enablePin()).toEqual({ success: true });
        expect(state.tpm.failures).toBe(0);
    });

    it('counts the TPM tries left when there are fewer than Vigil allows', async () => {
        state.tpm.lockout = { ...state.tpm.lockout, maxTries: 3 };
        await enablePin();
        expect((await bio.getBiometricPassword(DB, '000000')).error).toBe('Incorrect PIN, 2 attempts left');
        expect((await bio.getBiometricPassword(DB, '000000')).error).toBe('Incorrect PIN, 1 attempt left');
        expect((await bio.getBiometricPassword(DB, '000000')).error).toBe('Incorrect PIN. Too many incorrect PINs, the TPM is refusing attempts for now. Try again later');
    });

    it('needs a fresh start after a cancel or a finished setup', async () => {
        unprotected();
        const password = await begin();
        bio.cancelTpmLockout();
        expect(await bio.applyTpmLockout(password)).toMatchObject({ success: false, error: 'Start the setup again' });

        const next = await begin();
        await bio.applyTpmLockout(next);
        expect(await bio.applyTpmLockout(next)).toMatchObject({ success: false, error: 'Start the setup again' });
        expect(state.tpm.setLockoutCalls).toHaveLength(1);
    });

    it('never touches a lockout password set outside Vigil', async () => {
        state.tpm.lockout = { ok: true, lockoutAuthSet: true, maxTries: 1000, recoveryInterval: 7200 };
        expect(await bio.beginTpmLockout(true)).toMatchObject({ success: false });

        unprotected();
        const password = await begin();
        state.tpm.lockout = { ok: true, lockoutAuthSet: true, maxTries: 1000, recoveryInterval: 7200 };
        expect(await bio.applyTpmLockout(password)).toMatchObject({ success: false });
        expect(state.tpm.setLockoutCalls).toHaveLength(0);
    });

    it('reports a TPM that refuses the change', async () => {
        unprotected();
        state.tpm.setLockoutFails = true;
        expect(await bio.applyTpmLockout(await begin())).toMatchObject({ success: false, error: 'Vigil could not set the recovery password' });
        expect(await bio.getTpmSetupStep()).toBe('lockout');
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

    it('counts guesses per year from the limits Windows sets, 31 tries and 10 minutes', async () => {
        expect(await bio.getBiometricsInfo()).toMatchObject({ pinGuessesPerYear: 31 + 52560 });
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

    it('a key encrypted to the TPM key by someone else is refused and never seals a password', async () => {
        await bio.setBiometricsConfig({ requirePasswordAfterRestart: false });
        await enablePin();
        const [file] = fs.readdirSync(pinDir());
        const full = path.join(pinDir(), file);
        const tampered = JSON.parse(fs.readFileSync(full, 'utf8'));
        const [original] = state.tpm.objects.values();
        const attacker = generateKeyPairSync('x25519');
        state.tpm.objects.set('forged', {
            name: original.name,
            data: attacker.privateKey.export({ format: 'der', type: 'pkcs8' }),
            pin: PIN,
            forged: true,
        });
        tampered.sealed = Buffer.from('forged').toString('base64');
        tampered.publicKey = Buffer.from(attacker.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64');
        fs.writeFileSync(full, JSON.stringify(tampered));
        state.keytar.set(ACCOUNT, 'pin1-session:');
        restart();

        expect(await bio.enableBiometrics(DB, 'hunter2')).toEqual({ success: true });
        const result = await bio.getBiometricPassword(DB, PIN);
        expect(result.success).toBe(false);
        expect(result.retry).toBeFalsy();
        expect(result.error).toMatch(/modified outside Vigil/);
        expect(state.keytar.has(ACCOUNT)).toBe(false);
        expect(fs.readdirSync(pinDir())).toEqual([]);
    });
});

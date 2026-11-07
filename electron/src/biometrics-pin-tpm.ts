import { app } from 'electron';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as tpm from '../native/tpm';
import { createPinProvider, MIN_PIN_LENGTH, type PinVault } from './biometrics-pin';

const NO_ACCESS = 'PIN unlock needs access to the TPM: add your user to the tss group, then log out and back in';
const UNREACHABLE = 'PIN unlock could not reach the TPM';
const UNPROTECTED = 'PIN unlock needs the TPM to limit wrong PINs, which takes a lockout password. '
    + 'Set one with "tpm2_changeauth -c lockout <password>" and keep it somewhere safe, '
    + 'or allow PIN unlock without it in Settings';

// Beyond these, guessing every 6-digit PIN through the TPM is practical
const MAX_TRIES = 32;
const MIN_RECOVERY_SECONDS = 600;
export const UNPROTECTED_MIN_PIN_LENGTH = 10;

let linuxDevice = '/dev/tpmrm0';
let probeCache: ReturnType<typeof tpm.probe> | null = null;
let allowUnprotectedCache: boolean | null = null;

export function resetTpmForTests(device?: string): void {
    probeCache = null;
    allowUnprotectedCache = null;
    if (device) linuxDevice = device;
}

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'tpm-pin-config.json');

function allowUnprotected(): boolean {
    if (allowUnprotectedCache !== null) return allowUnprotectedCache;
    try {
        allowUnprotectedCache = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')).allowUnprotected === true;
    } catch {
        allowUnprotectedCache = false;
    }
    return allowUnprotectedCache;
}

// An empty lockout authorization lets any process with TPM access clear the
// failure counter or raise the limit, so the TPM bounds nothing. Only Linux
// leaves it to the user; Windows owns it
async function lockoutProtected(): Promise<boolean> {
    const lockout = await tpm.lockout();
    if (!lockout.ok) {
        console.error('Could not read the TPM lockout settings:', lockout.code, lockout.status);
        return false;
    }
    return lockout.lockoutAuthSet
        && lockout.maxTries <= MAX_TRIES
        && (lockout.recoveryInterval === 0 || lockout.recoveryInterval >= MIN_RECOVERY_SECONDS);
}

export interface PinLockoutPolicy {
    applies: boolean;
    protected: boolean;
    allowUnprotected: boolean;
}

export async function getPinLockoutPolicy(): Promise<PinLockoutPolicy> {
    const applies = process.platform === 'linux' && tpmPinVault.supported() && probe().ok;
    return {
        applies,
        protected: applies ? await lockoutProtected() : true,
        allowUnprotected: allowUnprotected()
    };
}

export async function setAllowUnprotectedTpm(allow: boolean): Promise<{ success: boolean; error?: string }> {
    try {
        fs.writeFileSync(CONFIG_PATH(), JSON.stringify({ allowUnprotected: allow }), { mode: 0o600 });
        allowUnprotectedCache = allow;
        return { success: true };
    } catch (error) {
        console.error('Failed to store the TPM PIN setting:', error);
        return { success: false, error: 'Failed to store the setting' };
    }
}

function probe(): ReturnType<typeof tpm.probe> {
    if (!probeCache) probeCache = tpm.probe();
    return probeCache;
}

function digest(account: string): string {
    return createHash('sha256').update(account).digest('hex');
}

const stateDir = () => path.join(app.getPath('userData'), 'pin');
const statePath = (account: string) => path.join(stateDir(), `${digest(account)}.json`);
const keyName = (account: string) => `Vigil PIN ${digest(account).slice(0, 32)}`;

function failure(result: { code: string; status: number }): string {
    return `${result.code} 0x${result.status.toString(16)}`;
}

function linuxDeviceAccessible(): boolean {
    try {
        fs.accessSync(linuxDevice, fs.constants.R_OK | fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

const tpmPinVault: PinVault = {
    supported() {
        if (!tpm.isLoaded()) return false;
        if (process.platform === 'linux') return fs.existsSync(linuxDevice);
        return probe().ok;
    },

    async refusal() {
        if (!probe().ok) {
            if (process.platform === 'linux' && !linuxDeviceAccessible()) return NO_ACCESS;
            return UNREACHABLE;
        }
        if (process.platform !== 'linux' || allowUnprotected() || await lockoutProtected()) return null;
        return UNPROTECTED;
    },

    async minPinLength() {
        if (process.platform !== 'linux' || await lockoutProtected()) return MIN_PIN_LENGTH;
        return UNPROTECTED_MIN_PIN_LENGTH;
    },

    async seal(account, data, pin) {
        const result = await tpm.seal(keyName(account), data, pin);
        return result.ok ? { ok: true, sealed: result.sealed.toString('base64') } : { ok: false, code: failure(result) };
    },

    async unseal(account, pin, sealed) {
        if (!sealed) return { ok: false, code: 'not-found' };
        const result = await tpm.unseal(keyName(account), pin, Buffer.from(sealed, 'base64'));
        if (result.ok) return { ok: true, data: result.data };
        if (result.code === 'wrong-pin' || result.code === 'locked-out' || result.code === 'not-found') {
            return { ok: false, code: result.code };
        }
        if (result.code === 'bad-input') return { ok: false, code: 'not-found' };
        return { ok: false, code: failure(result) };
    },

    async readState(account) {
        try {
            return { ok: true, data: await fs.promises.readFile(statePath(account)) };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return { ok: false, code: code === 'ENOENT' ? 'not-found' : String(code) };
        }
    },

    async writeState(account, data) {
        const target = statePath(account);
        const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        try {
            await fs.promises.mkdir(stateDir(), { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(temporary, data, { mode: 0o600 });
            await fs.promises.rename(temporary, target);
            return true;
        } catch (error) {
            console.error('Failed to store the PIN state:', error);
            await fs.promises.rm(temporary, { force: true }).catch(() => {});
            return false;
        }
    },

    async wipe(account) {
        const removed = await tpm.remove(keyName(account));
        if (!removed.ok && removed.code !== 'unavailable') console.error('Failed to remove the TPM PIN key:', failure(removed));
        await fs.promises.rm(statePath(account), { force: true });
    }
};

export const tpmPin = createPinProvider(tpmPinVault);

import { app } from 'electron';
import { execFile } from 'child_process';
import { createHash, randomBytes, randomInt } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as tpm from '../native/tpm';
import { createPinProvider, MIN_PIN_LENGTH, type PinVault } from './biometrics-pin';

const NO_ACCESS = 'PIN unlock needs a one-time setup on this computer';
const UNREACHABLE = 'PIN unlock could not reach this computer\'s security chip';
const UNPROTECTED = 'PIN unlock needs a one-time setup that limits wrong PIN guesses. '
    + 'You can also allow it without that in Settings';
const TOO_FEW_TRIES = 'PIN unlock cannot work on this computer: its security chip allows fewer than 2 wrong PINs';

// Beyond these, guessing every 6-digit PIN through the TPM is practical
const MAX_TRIES = 32;
const MIN_RECOVERY_SECONDS = 600;
const DEFAULT_RECOVERY_SECONDS = 7200;
const MIN_TRIES = 2;
export const UNPROTECTED_MIN_PIN_LENGTH = 10;
const SECONDS_PER_YEAR = 365 * 24 * 3600;
const WINDOWS_MAX_TRIES = 31;
const WINDOWS_RECOVERY_SECONDS = 600;
const UNPROTECTED_GUESSES_PER_SECOND = 1;

const guessesInAYear = (maxTries: number, recoveryInterval: number) =>
    maxTries + Math.floor(SECONDS_PER_YEAR / recoveryInterval);

const limitsGuessing = (lockout: { lockoutAuthSet: boolean; maxTries: number; recoveryInterval: number }) =>
    lockout.lockoutAuthSet && lockout.maxTries <= MAX_TRIES && lockout.recoveryInterval >= MIN_RECOVERY_SECONDS;

const UDEV_RULE = 'SUBSYSTEM=="tpmrm", KERNEL=="tpmrm[0-9]*", TAG+="uaccess"';
const UDEV_RULE_PATH = '/etc/udev/rules.d/70-vigil-tpm.rules';
const GRANT_SCRIPT = `printf '%s\\n' '${UDEV_RULE}' > ${UDEV_RULE_PATH}`
    + ' && udevadm control --reload && udevadm trigger --subsystem-match=tpmrm --action=change && udevadm settle';
export const TPM_ACCESS_COMMANDS = [
    `echo '${UDEV_RULE}' | sudo tee ${UDEV_RULE_PATH}`,
    'sudo udevadm trigger --subsystem-match=tpmrm --action=change',
];
const REVOKE_SCRIPT = `rm -f ${UDEV_RULE_PATH}`
    + ' && udevadm control --reload && udevadm trigger --subsystem-match=tpmrm --action=change && udevadm settle'
    + ' && for device in /dev/tpmrm*; do setfacl -x "u:$PKEXEC_UID" "$device" 2>/dev/null || true; done';
export const TPM_REVOKE_COMMANDS = [
    `sudo rm ${UDEV_RULE_PATH}`,
    'sudo udevadm trigger --subsystem-match=tpmrm --action=change',
    'sudo setfacl -x "u:$USER" /dev/tpmrm0',
];

const RECOVERY_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

let linuxDevice = '/dev/tpmrm0';
let udevRulePath = UDEV_RULE_PATH;
let pkexecPaths = ['/usr/bin/pkexec', '/run/wrappers/bin/pkexec'];
let probeCache: ReturnType<typeof tpm.probe> | null = null;
let allowUnprotectedCache: boolean | null = null;
let pendingRecovery: { password: string; change: TpmLimitChange | null } | null = null;

export function resetTpmForTests(device?: string, pkexec?: string[], rulePath?: string): void {
    probeCache = null;
    allowUnprotectedCache = null;
    pendingRecovery = null;
    if (device) linuxDevice = device;
    if (pkexec) pkexecPaths = pkexec;
    if (rulePath) udevRulePath = rulePath;
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
// leaves it to the user; Windows owns it. A recovery time of zero turns
// dictionary-attack protection off entirely, so it fails the minimum too
async function lockoutProtected(): Promise<boolean> {
    const lockout = await tpm.lockout();
    if (!lockout.ok) {
        console.error('Could not read the TPM lockout settings:', lockout.code, lockout.status);
        return false;
    }
    return limitsGuessing(lockout);
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

export type TpmSetupStep = 'access' | 'lockout' | 'foreign-lockout' | 'too-few-tries' | 'unreachable';

async function tooFewTries(): Promise<boolean> {
    const lockout = await tpm.lockout();
    return lockout.ok && lockout.maxTries < MIN_TRIES;
}

export async function getTpmSetupStep(): Promise<TpmSetupStep | null> {
    if (process.platform !== 'linux' || !tpmPinVault.supported()) return null;
    if (!probe().ok) return linuxDeviceAccessible() ? 'unreachable' : 'access';
    const lockout = await tpm.lockout();
    if (!lockout.ok) return 'unreachable';
    if (lockout.maxTries < MIN_TRIES) return 'too-few-tries';
    if (await lockoutProtected()) return null;
    return lockout.lockoutAuthSet ? 'foreign-lockout' : 'lockout';
}

export interface TpmLimitChange {
    maxTries?: { from: number; to: number };
    recoveryInterval?: { from: number; to: number };
}

function limitChange(lockout: { maxTries: number; recoveryInterval: number }): TpmLimitChange | null {
    const change: TpmLimitChange = {};
    if (lockout.maxTries > MAX_TRIES) change.maxTries = { from: lockout.maxTries, to: MAX_TRIES };
    if (lockout.recoveryInterval < MIN_RECOVERY_SECONDS) {
        change.recoveryInterval = { from: lockout.recoveryInterval, to: DEFAULT_RECOVERY_SECONDS };
    }
    return change.maxTries || change.recoveryInterval ? change : null;
}

const sameChange = (a: TpmLimitChange | null, b: TpmLimitChange | null) => JSON.stringify(a) === JSON.stringify(b);

export async function getTpmLockoutPlan(): Promise<{ success: true; change: TpmLimitChange | null } | { success: false; error: string }> {
    if (await getTpmSetupStep() !== 'lockout') return { success: false, error: 'This computer does not need this setup' };
    const lockout = await tpm.lockout();
    if (!lockout.ok) return { success: false, error: 'Vigil could not read the security chip\'s settings' };
    return { success: true, change: limitChange(lockout) };
}

export type TpmAccessResult =
    | { success: true }
    | { success: false; cancelled?: boolean; error: string; commands?: string[] };

function runElevated(pkexec: string, script: string): Promise<number> {
    return new Promise(resolve => {
        execFile(pkexec, ['/bin/sh', '-c', script], error => {
            if (!error) resolve(0);
            else resolve(typeof error.code === 'number' ? error.code : -1);
        });
    });
}

export function tpmAccessGranted(): boolean {
    return process.platform === 'linux' && fs.existsSync(udevRulePath);
}

export async function revokeTpmAccess(): Promise<TpmAccessResult> {
    if (!tpmAccessGranted()) return { success: true };
    const pkexec = pkexecPaths.find(candidate => fs.existsSync(candidate));
    const manual = { success: false as const, commands: TPM_REVOKE_COMMANDS };
    if (!pkexec) {
        return { ...manual, error: 'Vigil could not ask for your administrator password. Run these commands in a terminal instead' };
    }
    const code = await runElevated(pkexec, REVOKE_SCRIPT);
    probeCache = null;
    if (code === 126) return { success: false, cancelled: true, error: 'The administrator password was not given' };
    if (code !== 0) {
        console.error('Removing TPM access failed with exit code', code);
        return { ...manual, error: 'Vigil could not make the change. Run these commands in a terminal instead' };
    }
    if (linuxDeviceAccessible()) {
        return { success: false, error: 'Vigil removed its permission, but apps you run can still use the security chip. Restarting the computer may end that' };
    }
    return { success: true };
}

export async function grantTpmAccess(): Promise<TpmAccessResult> {
    if (await getTpmSetupStep() !== 'access') {
        probeCache = null;
        return { success: true };
    }
    const pkexec = pkexecPaths.find(candidate => fs.existsSync(candidate));
    const manual = { success: false as const, commands: TPM_ACCESS_COMMANDS };
    if (!pkexec) {
        return { ...manual, error: 'Vigil could not ask for your administrator password. Run these commands in a terminal instead' };
    }
    const code = await runElevated(pkexec, GRANT_SCRIPT);
    probeCache = null;
    if (code === 126) return { success: false, cancelled: true, error: 'The administrator password was not given' };
    if (code !== 0) {
        console.error('Granting TPM access failed with exit code', code);
        return { ...manual, error: 'Vigil could not make the change. Run these commands in a terminal instead' };
    }
    if (!linuxDeviceAccessible() || !probe().ok) {
        return { success: false, error: 'The change was made, but Vigil still cannot use the security chip. Logging out and back in may fix this' };
    }
    return { success: true };
}

export async function beginTpmLockout(acceptLimits: boolean): Promise<{ success: true; password: string } | { success: false; error: string }> {
    pendingRecovery = null;
    const plan = await getTpmLockoutPlan();
    if (!plan.success) return plan;
    if (plan.change && !acceptLimits) return { success: false, error: 'Changing the limits needs your consent' };
    const group = () => Array.from({ length: 4 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    const password = [group(), group(), group(), group()].join('-');
    pendingRecovery = { password, change: plan.change };
    return { success: true, password };
}

export function cancelTpmLockout(): void {
    pendingRecovery = null;
}

export async function applyTpmLockout(typed: string): Promise<{ success: boolean; mismatch?: boolean; error?: string }> {
    if (!pendingRecovery) return { success: false, error: 'Start the setup again' };
    if (typed.trim().toLowerCase() !== pendingRecovery.password) {
        return { success: false, mismatch: true, error: 'This does not match the recovery password' };
    }
    const { password, change } = pendingRecovery;
    pendingRecovery = null;
    const lockout = await tpm.lockout();
    if (!lockout.ok || lockout.lockoutAuthSet || lockout.maxTries < MIN_TRIES || !sameChange(limitChange(lockout), change)) {
        return { success: false, error: 'The security chip changed since the setup started. Start it again' };
    }
    const limits = change && {
        maxTries: change.maxTries?.to ?? lockout.maxTries,
        recoveryInterval: change.recoveryInterval?.to ?? lockout.recoveryInterval,
        lockoutRecovery: lockout.lockoutRecovery,
    };
    const auth = Buffer.from(password, 'utf8');
    const result = await tpm.setLockout(auth, limits);
    auth.fill(0);
    if (!result.ok) {
        console.error('Failed to set the TPM lockout password:', failure(result));
        return { success: false, error: 'Vigil could not set the recovery password' };
    }
    if (!await lockoutProtected()) {
        return { success: false, error: 'The recovery password was set, but the security chip still does not limit wrong PINs' };
    }
    return { success: true };
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
    countsWrongPins: true,

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
        if (process.platform !== 'linux') return null;
        if (await tooFewTries()) return TOO_FEW_TRIES;
        if (allowUnprotected() || await lockoutProtected()) return null;
        return UNPROTECTED;
    },

    async remainingTries() {
        if (process.platform !== 'linux') return null;
        const lockout = await tpm.lockout();
        return lockout.ok ? Math.max(0, lockout.maxTries - lockout.failures) : null;
    },

    async minPinLength() {
        if (process.platform !== 'linux' || await lockoutProtected()) return MIN_PIN_LENGTH;
        return UNPROTECTED_MIN_PIN_LENGTH;
    },

    async guessesPerYear() {
        if (process.platform !== 'linux') return guessesInAYear(WINDOWS_MAX_TRIES, WINDOWS_RECOVERY_SECONDS);
        const lockout = await tpm.lockout();
        if (!lockout.ok || !limitsGuessing(lockout)) return UNPROTECTED_GUESSES_PER_SECOND * SECONDS_PER_YEAR;
        return guessesInAYear(lockout.maxTries, lockout.recoveryInterval);
    },

    async seal(account, data, pin) {
        const result = await tpm.seal(keyName(account), data, pin);
        return result.ok ? { ok: true, sealed: result.sealed.toString('base64') } : { ok: false, code: failure(result) };
    },

    async unseal(account, pin, sealed) {
        if (!sealed) return { ok: false, code: 'not-found' };
        const result = await tpm.unseal(keyName(account), pin, Buffer.from(sealed, 'base64'));
        if (result.ok) return { ok: true, data: result.data };
        if (['wrong-pin', 'locked-out', 'not-found', 'tampered', 'unavailable'].includes(result.code)) {
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

import { app } from 'electron';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as tpm from '../native/tpm';
import { createPinProvider, type PinVault } from './biometrics-pin';

const NO_ACCESS = 'PIN unlock needs access to the TPM: add your user to the tss group, then log out and back in';
const UNREACHABLE = 'PIN unlock could not reach the TPM';

let linuxDevice = '/dev/tpmrm0';
let probeCache: ReturnType<typeof tpm.probe> | null = null;

export function resetTpmForTests(device?: string): void {
    probeCache = null;
    if (device) linuxDevice = device;
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
        if (probe().ok) return null;
        if (process.platform === 'linux' && !linuxDeviceAccessible()) return NO_ACCESS;
        return UNREACHABLE;
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

import * as touchid from '../native/touchid';
import { createPinProvider, type PinVault } from './biometrics-pin';
import { keychainRefusal } from './biometrics-touchid';

const keychainPinVault: PinVault = {
    supported: () => touchid.isLoaded() && touchid.pinSupported(),
    refusal: keychainRefusal,

    async seal(account, data, pin) {
        const written = await touchid.setPinSecret(account, data, pin);
        return written.ok ? { ok: true } : { ok: false, code: `${written.code} ${written.status ?? ''}`.trim() };
    },

    async unseal(account, pin) {
        const released = await touchid.getPinSecret(account, pin);
        if (released.ok) return { ok: true, data: released.data };
        if (released.code === 'auth-failed') return { ok: false, code: 'wrong-pin' };
        return { ok: false, code: released.code === 'not-found' ? 'not-found' : `${released.code} ${released.status ?? ''}`.trim() };
    },

    async readState(account) {
        const read = await touchid.getPinState(account);
        return read.ok ? { ok: true, data: read.data } : { ok: false, code: read.code };
    },

    async writeState(account, data) {
        return (await touchid.setPinState(account, data)).ok;
    },

    async wipe(account) {
        await touchid.deletePinSecret(account);
        await touchid.deletePinState(account);
    }
};

export const macPin = createPinProvider(keychainPinVault);

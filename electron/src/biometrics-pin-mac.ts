import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'crypto';
import * as touchid from '../native/touchid';
import {
    isPinBlob,
    sealPinPassword,
    pinBindingFromBlob,
    openPinPassword,
    sealPinSession,
    pinSessionBinding,
    openPinSession
} from './biometrics-crypto';
import { ArmError, ReleaseError, type QuickUnlockProvider } from './biometrics-provider';
import { keychainRefusal } from './biometrics-touchid';

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_PATTERN = /^\d{6,32}$/;

const NO_SALT = Buffer.alloc(0);
const RESET_MESSAGE = 'PIN unlock was reset for this database, set it up again with your master password';
const LOCKED_OUT_MESSAGE = 'Too many incorrect PINs, PIN unlock was turned off for this database';

interface PinState {
    publicKey: string;
    failures: number;
}

type StateRead = { kind: 'ok'; state: PinState } | { kind: 'missing' } | { kind: 'error'; code: string };

async function readState(account: string): Promise<StateRead> {
    const read = await touchid.getPinState(account);
    if (!read.ok) return read.code === 'not-found' ? { kind: 'missing' } : { kind: 'error', code: read.code };
    try {
        const parsed = JSON.parse(read.data.toString('utf8'));
        if (typeof parsed?.publicKey === 'string' && Number.isInteger(parsed?.failures) && parsed.failures >= 0) {
            return { kind: 'ok', state: { publicKey: parsed.publicKey, failures: parsed.failures } };
        }
    } catch { /* malformed */ }
    return { kind: 'error', code: 'malformed' };
}

async function writeState(account: string, state: PinState): Promise<boolean> {
    return (await touchid.setPinState(account, Buffer.from(JSON.stringify(state), 'utf8'))).ok;
}

async function wipe(account: string): Promise<void> {
    await touchid.deletePinSecret(account);
    await touchid.deletePinState(account);
}

function rawPublicKey(key: KeyObject): Buffer {
    return Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url');
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

async function enroll(account: string, pin: string): Promise<void> {
    if (!PIN_PATTERN.test(pin)) throw new ArmError('A PIN is 6 to 32 digits');

    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    try {
        const written = await touchid.setPinSecret(account, privateDer, pin);
        if (!written.ok) {
            console.error('PIN keychain write failed:', written.code, written.status ?? '');
            throw new ArmError('Could not set up PIN unlock: the keychain refused the key');
        }
        const readBack = await touchid.getPinSecret(account, pin);
        const matches = readBack.ok && readBack.data.equals(privateDer);
        if (readBack.ok) readBack.data.fill(0);
        if (!matches) {
            await touchid.deletePinSecret(account);
            throw new ArmError('Could not set up PIN unlock: the keychain did not release the key it stored');
        }
        if (!await writeState(account, { publicKey: rawPublicKey(publicKey).toString('base64'), failures: 0 })) {
            await touchid.deletePinSecret(account);
            throw new ArmError('Could not set up PIN unlock: the keychain refused the PIN state');
        }
    } finally {
        privateDer.fill(0);
    }
}

export const macPin: QuickUnlockProvider = {
    id: 'pin',
    method: 'PIN',
    needsPin: true,
    sessionMarker: 'pin1-session:',

    supported: () => touchid.isLoaded() && touchid.pinSupported(),
    biometryType: () => 'pin',
    refusal: keychainRefusal,

    async arm(target, _confirm, pin) {
        if (pin !== undefined) await enroll(target.account, pin);

        const read = await readState(target.account);
        if (read.kind === 'missing') throw new ArmError('Set a PIN to turn on PIN unlock');
        if (read.kind === 'error') {
            console.error('PIN state read failed:', read.code);
            throw new ArmError('Could not read the PIN setup from the keychain');
        }

        const ephemeral = generateKeyPairSync('x25519');
        const secret = diffieHellman({
            privateKey: ephemeral.privateKey,
            publicKey: publicKeyFromRaw(Buffer.from(read.state.publicKey, 'base64'))
        });
        return { secret, binding: rawPublicKey(ephemeral.publicKey) };
    },

    async release(target, binding, pin) {
        if (!pin) throw new ReleaseError('wrong-pin', 'Enter your PIN');

        const read = await readState(target.account);
        if (read.kind === 'missing') throw new ReleaseError('revoked', RESET_MESSAGE);
        if (read.kind === 'error') throw new ReleaseError('failed', `PIN state ${read.code}`);

        const failures = read.state.failures + 1;
        if (!await writeState(target.account, { ...read.state, failures })) {
            throw new ReleaseError('failed', 'Could not record the PIN attempt');
        }

        const released = await touchid.getPinSecret(target.account, pin);
        if (released.ok) {
            await writeState(target.account, { ...read.state, failures: 0 });
            try {
                const privateKey = createPrivateKey({ key: released.data, format: 'der', type: 'pkcs8' });
                return diffieHellman({ privateKey, publicKey: publicKeyFromRaw(binding) });
            } finally {
                released.data.fill(0);
            }
        }

        if (released.code === 'auth-failed') {
            if (failures >= MAX_PIN_ATTEMPTS) {
                await wipe(target.account);
                throw new ReleaseError('revoked', LOCKED_OUT_MESSAGE);
            }
            const left = MAX_PIN_ATTEMPTS - failures;
            throw new ReleaseError('wrong-pin', `Incorrect PIN, ${left} ${left === 1 ? 'attempt' : 'attempts'} left`);
        }
        await writeState(target.account, read.state);
        if (released.code === 'not-found') {
            await wipe(target.account);
            throw new ReleaseError('revoked', RESET_MESSAGE);
        }
        throw new ReleaseError('failed', `${released.code} ${released.status ?? ''}`.trim());
    },

    async retire() {},

    async remove(target) {
        await wipe(target.account);
    },

    persistent: {
        isBlob: isPinBlob,
        binding: pinBindingFromBlob,
        sealer: () => (password, material) => sealPinPassword(password, material.binding, material.secret),
        opener: () => openPinPassword
    },

    session: {
        seal: (password, material) => ({ blob: sealPinSession(password, material.binding, material.secret), salt: NO_SALT }),
        binding: (sealed) => pinSessionBinding(sealed.blob),
        open: (sealed, secret) => openPinSession(sealed.blob, secret)
    }
};

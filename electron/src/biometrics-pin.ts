import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'crypto';
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

export const MAX_PIN_ATTEMPTS = 5;
export const MIN_PIN_LENGTH = 6;
export const PIN_PATTERN = /^\d{6,32}$/;

export type VaultResult<T> = ({ ok: true } & T) | { ok: false; code: string };

export interface PinVault {
    supported(): boolean;
    refusal(): Promise<string | null>;
    minPinLength?(): Promise<number>;
    seal(account: string, data: Buffer, pin: string): Promise<VaultResult<{ sealed?: string }>>;
    unseal(account: string, pin: string, sealed?: string): Promise<VaultResult<{ data: Buffer }>>;
    readState(account: string): Promise<VaultResult<{ data: Buffer }>>;
    writeState(account: string, data: Buffer): Promise<boolean>;
    wipe(account: string): Promise<void>;
}

const NO_SALT = Buffer.alloc(0);
const RESET_MESSAGE = 'PIN unlock was reset for this database, set it up again with your master password';
const LOCKED_OUT_MESSAGE = 'Too many incorrect PINs, PIN unlock was turned off for this database';
const TAMPERED_MESSAGE = 'The PIN setup was modified outside Vigil, PIN unlock was turned off for this database';
const HARDWARE_LOCKOUT_MESSAGE = 'Too many incorrect PINs, the TPM is refusing attempts for now. Try again later';

const EPOCH_LENGTH = 32;

// The epoch is mixed into every secret the PIN key releases and replaced when
// the vault's persistent blob is retired, so a copy of that blob which
// outlived the keytar record (a keychain backup, credential roaming) no
// longer opens: the same guarantee deleting the DPAPI entropy gives Hello
interface PinState {
    publicKey: string;
    epoch: string;
    failures: number;
    sealed?: string;
}

type StateRead = { kind: 'ok'; state: PinState } | { kind: 'missing' } | { kind: 'error'; code: string };

function newEpoch(): string {
    return randomBytes(EPOCH_LENGTH).toString('base64');
}

function withEpoch(shared: Buffer, epoch: string): Buffer {
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(epoch, 'base64'), 'vigil-pin-epoch', 32));
}

async function readState(vault: PinVault, account: string): Promise<StateRead> {
    const read = await vault.readState(account);
    if (!read.ok) return read.code === 'not-found' ? { kind: 'missing' } : { kind: 'error', code: read.code };
    try {
        const parsed = JSON.parse(read.data.toString('utf8'));
        const sealedOk = parsed?.sealed === undefined || typeof parsed.sealed === 'string';
        const epochOk = typeof parsed?.epoch === 'string' && Buffer.from(parsed.epoch, 'base64').length === EPOCH_LENGTH;
        if (typeof parsed?.publicKey === 'string' && epochOk && Number.isInteger(parsed?.failures) && parsed.failures >= 0 && sealedOk) {
            return {
                kind: 'ok',
                state: { publicKey: parsed.publicKey, epoch: parsed.epoch, failures: parsed.failures, sealed: parsed.sealed }
            };
        }
    } catch { /* malformed */ }
    return { kind: 'error', code: 'malformed' };
}

function writeState(vault: PinVault, account: string, state: PinState): Promise<boolean> {
    return vault.writeState(account, Buffer.from(JSON.stringify(state), 'utf8'));
}

function minPinLength(vault: PinVault): Promise<number> {
    return vault.minPinLength?.() ?? Promise.resolve(MIN_PIN_LENGTH);
}

function rawPublicKey(key: KeyObject): Buffer {
    return Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url');
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

interface EnrolledKey {
    publicKey: Buffer;
    epoch: string;
}

async function enroll(vault: PinVault, account: string, pin: string): Promise<EnrolledKey> {
    const minLength = await minPinLength(vault);
    if (!PIN_PATTERN.test(pin) || pin.length < minLength) throw new ArmError(`A PIN is ${minLength} to 32 digits`);

    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    try {
        const written = await vault.seal(account, privateDer, pin);
        if (!written.ok) {
            console.error('PIN key could not be stored:', written.code);
            throw new ArmError('Could not set up PIN unlock: the key store refused the key');
        }
        const readBack = await vault.unseal(account, pin, written.sealed);
        const matches = readBack.ok && readBack.data.equals(privateDer);
        if (readBack.ok) readBack.data.fill(0);
        if (!matches) {
            await vault.wipe(account);
            throw new ArmError('Could not set up PIN unlock: the key store did not release the key it stored');
        }
        const decoy = (pin[0] === '0' ? '1' : '0') + pin.slice(1);
        const refused = await vault.unseal(account, decoy, written.sealed);
        if (refused.ok) refused.data.fill(0);
        if (refused.ok || refused.code !== 'wrong-pin') {
            await vault.wipe(account);
            console.error('PIN key store accepted a wrong PIN or failed to check it:', refused.ok ? 'accepted' : refused.code);
            throw new ArmError('Could not set up PIN unlock: the key store did not enforce the PIN');
        }
        const raw = rawPublicKey(publicKey);
        const state = { publicKey: raw.toString('base64'), epoch: newEpoch(), failures: 0, sealed: written.sealed };
        if (!await writeState(vault, account, state)) {
            await vault.wipe(account);
            throw new ArmError('Could not set up PIN unlock: the PIN state could not be stored');
        }
        return { publicKey: raw, epoch: state.epoch };
    } finally {
        privateDer.fill(0);
    }
}

export function createPinProvider(vault: PinVault): QuickUnlockProvider {
    const queues = new Map<string, Promise<unknown>>();

    function exclusive<T>(account: string, task: () => Promise<T>): Promise<T> {
        const previous = queues.get(account) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(task);
        queues.set(account, current);
        const forget = () => {
            if (queues.get(account) === current) queues.delete(account);
        };
        current.then(forget, forget);
        return current;
    }

    return {
        id: 'pin',
        method: 'PIN',
        needsPin: true,
        sessionMarker: 'pin1-session:',

        supported: () => vault.supported(),
        biometryType: () => 'pin',
        refusal: () => vault.refusal(),
        minPinLength: () => minPinLength(vault),

        async arm(target, _confirm, pin) {
            const { publicKey, epoch } = pin !== undefined
                ? await exclusive(target.account, () => enroll(vault, target.account, pin))
                : await storedKey(target.account);

            const ephemeral = generateKeyPairSync('x25519');
            const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyFromRaw(publicKey) });
            return { secret: withEpoch(shared, epoch), binding: rawPublicKey(ephemeral.publicKey) };
        },

        async release(target, binding, pin) {
            if (!pin) throw new ReleaseError('wrong-pin', 'Enter your PIN');
            if (!PIN_PATTERN.test(pin)) throw new ReleaseError('wrong-pin', 'A PIN is 6 to 32 digits');
            return exclusive(target.account, () => attempt(target.account, binding, pin));
        },

        async retire(account) {
            await exclusive(account, async () => {
                const read = await readState(vault, account);
                if (read.kind !== 'ok') return;
                if (!await writeState(vault, account, { ...read.state, epoch: newEpoch() })) {
                    console.error('Failed to rotate the PIN epoch, an old copy of the retired blob still opens');
                }
            });
        },

        async remove(target) {
            await exclusive(target.account, () => vault.wipe(target.account));
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

    async function storedKey(account: string): Promise<EnrolledKey> {
        const read = await readState(vault, account);
        if (read.kind === 'missing') throw new ArmError('Set a PIN to turn on PIN unlock');
        if (read.kind === 'error') {
            console.error('PIN state read failed:', read.code);
            throw new ArmError('Could not read the PIN setup');
        }
        return { publicKey: Buffer.from(read.state.publicKey, 'base64'), epoch: read.state.epoch };
    }

    async function attempt(account: string, binding: Buffer, pin: string): Promise<Buffer> {
        const read = await readState(vault, account);
        if (read.kind === 'missing') throw new ReleaseError('revoked', RESET_MESSAGE);
        if (read.kind === 'error') throw new ReleaseError('failed', `PIN state ${read.code}`);

        const failures = read.state.failures + 1;
        if (!await writeState(vault, account, { ...read.state, failures })) {
            throw new ReleaseError('failed', 'Could not record the PIN attempt');
        }

        const released = await vault.unseal(account, pin, read.state.sealed);
        if (released.ok) {
            try {
                const privateKey = createPrivateKey({ key: released.data, format: 'der', type: 'pkcs8' });
                if (!rawPublicKey(createPublicKey(privateKey)).equals(Buffer.from(read.state.publicKey, 'base64'))) {
                    console.error('PIN state public key does not match the sealed private key');
                    await vault.wipe(account);
                    throw new ReleaseError('revoked', TAMPERED_MESSAGE);
                }
                await writeState(vault, account, { ...read.state, failures: 0 });
                return withEpoch(diffieHellman({ privateKey, publicKey: publicKeyFromRaw(binding) }), read.state.epoch);
            } finally {
                released.data.fill(0);
            }
        }

        if (released.code === 'wrong-pin') {
            if (failures >= MAX_PIN_ATTEMPTS) {
                await vault.wipe(account);
                throw new ReleaseError('revoked', LOCKED_OUT_MESSAGE);
            }
            const left = MAX_PIN_ATTEMPTS - failures;
            throw new ReleaseError('wrong-pin', `Incorrect PIN, ${left} ${left === 1 ? 'attempt' : 'attempts'} left`);
        }
        await writeState(vault, account, read.state);
        if (released.code === 'locked-out') throw new ReleaseError('wrong-pin', HARDWARE_LOCKOUT_MESSAGE);
        if (released.code === 'not-found') {
            await vault.wipe(account);
            throw new ReleaseError('revoked', RESET_MESSAGE);
        }
        throw new ReleaseError('failed', released.code);
    }
}

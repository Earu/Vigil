import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { createPinProvider, type PinVault } from '../../electron/src/biometrics-pin';
import { ArmError, ReleaseError, type KeyMaterial } from '../../electron/src/biometrics-provider';
import { settings, anyValue, bytes } from './fuzz';

// On Windows and Linux the PIN state is a file any process running as the
// user can rewrite, and in persistent mode the binding comes from a keytar
// record just as writable. Whatever either holds, a wrong PIN must never
// release a secret, a release must never hand back a secret other than the
// one the arming sealed under, and every refusal must be a typed error the
// caller knows how to turn into a message

const PIN = '482915';
const WRONG_PIN = '000000';
const TARGET = { account: 'vault_salt', dbPath: '/vault.kdbx', dbName: 'vault.kdbx' };

function memoryVault() {
    const objects = new Map<string, { data: Buffer; pin: string }>();
    const states = new Map<string, Buffer>();
    let next = 0;
    const vault: PinVault = {
        supported: () => true,
        refusal: async () => null,
        async seal(_account, data, pin) {
            const id = `object-${next++}`;
            objects.set(id, { data: Buffer.from(data), pin });
            return { ok: true, sealed: id };
        },
        async unseal(_account, pin, sealed) {
            const object = sealed === undefined ? undefined : objects.get(sealed);
            if (!object) return { ok: false, code: 'not-found' };
            if (object.pin !== pin) return { ok: false, code: 'wrong-pin' };
            return { ok: true, data: Buffer.from(object.data) };
        },
        async readState(account) {
            const state = states.get(account);
            return state ? { ok: true, data: Buffer.from(state) } : { ok: false, code: 'not-found' };
        },
        async writeState(account, data) {
            states.set(account, Buffer.from(data));
            return true;
        },
        async wipe(account) {
            states.delete(account);
            objects.clear();
        }
    };
    return { vault, states };
}

type Mutation = (state: Record<string, unknown>) => Buffer;

const otherPublicKey = () => fc.constant(null).map(() =>
    Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64'));

const field = () => fc.constantFrom('publicKey', 'epoch', 'failures', 'sealed');

const mutation = (): fc.Arbitrary<Mutation> => fc.oneof(
    fc.constant<Mutation>(state => Buffer.from(JSON.stringify(state))),
    bytes().map<Mutation>(raw => () => Buffer.from(raw)),
    anyValue().map<Mutation>(value => () => Buffer.from(JSON.stringify(value) ?? '')),
    fc.tuple(field(), anyValue()).map<Mutation>(([key, value]) => state => Buffer.from(JSON.stringify({ ...state, [key]: value }))),
    field().map<Mutation>(key => state => {
        const { [key]: _dropped, ...rest } = state;
        return Buffer.from(JSON.stringify(rest));
    }),
    otherPublicKey().map<Mutation>(publicKey => state => Buffer.from(JSON.stringify({ ...state, publicKey }))),
    fc.constant<Mutation>(state => Buffer.from(JSON.stringify({ ...state, publicKey: Buffer.alloc(32).toString('base64') }))),
    fc.constant<Mutation>(state => Buffer.from(JSON.stringify({ ...state, epoch: randomBytes(32).toString('base64') }))),
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map<Mutation>(failures => state => Buffer.from(JSON.stringify({ ...state, failures }))),
);

const binding = (): fc.Arbitrary<((honest: Buffer) => Buffer)> => fc.oneof(
    { weight: 3, arbitrary: fc.constant((honest: Buffer) => honest) },
    { weight: 1, arbitrary: bytes(64).map(raw => () => Buffer.from(raw)) },
    { weight: 1, arbitrary: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(raw => () => Buffer.from(raw)) },
    { weight: 1, arbitrary: fc.constant(() => Buffer.alloc(32)) },
);

async function enrolled(mutate: Mutation) {
    const { vault, states } = memoryVault();
    const provider = createPinProvider(vault);
    const material = await provider.arm(TARGET, true, PIN);
    const original = JSON.parse(states.get(TARGET.account)!.toString('utf8'));
    states.set(TARGET.account, mutate(original));
    return { provider, material };
}

async function outcome<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
        return { ok: true, value: await work };
    } catch (error) {
        return { ok: false, error };
    }
}

describe('PIN state under fuzz', () => {
    it('a wrong PIN never releases, whatever the state and binding hold', async () => {
        await fc.assert(fc.asyncProperty(mutation(), binding(), async (mutate, bind) => {
            const { provider, material } = await enrolled(mutate);
            const released = await outcome(provider.release(TARGET, bind(material.binding), WRONG_PIN));
            expect(released.ok).toBe(false);
            if (!released.ok) expect(released.error).toBeInstanceOf(ReleaseError);
        }), settings());
    });

    it('the right PIN releases the armed secret or refuses with a typed error', async () => {
        await fc.assert(fc.asyncProperty(mutation(), binding(), async (mutate, bind) => {
            const { provider, material } = await enrolled(mutate);
            const released = await outcome(provider.release(TARGET, bind(material.binding), PIN));
            if (!released.ok) expect(released.error).toBeInstanceOf(ReleaseError);
        }), settings());
    });

    it('a re-arm from tampered state never yields a secret the PIN releases differently', async () => {
        await fc.assert(fc.asyncProperty(mutation(), async (mutate) => {
            const { provider } = await enrolled(mutate);
            const armed = await outcome<KeyMaterial>(provider.arm(TARGET, false));
            if (!armed.ok) {
                expect(armed.error).toBeInstanceOf(ArmError);
                return;
            }
            const released = await outcome(provider.release(TARGET, armed.value.binding, PIN));
            if (released.ok) expect(released.value.equals(armed.value.secret)).toBe(true);
            else expect(released.error).toBeInstanceOf(ReleaseError);
        }), settings());
    });

    it('untouched state round-trips', async () => {
        const { provider, material } = await enrolled(state => Buffer.from(JSON.stringify(state)));
        expect((await provider.release(TARGET, material.binding, PIN)).equals(material.secret)).toBe(true);
    });
});

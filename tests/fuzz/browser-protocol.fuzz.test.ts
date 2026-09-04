import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import nacl from 'tweetnacl';
import { settings, anyText, anyValue, bytes } from './fuzz';

// The socket server parses whatever a local process writes to the pipe. An
// envelope of any shape must come back as a protocol error rather than an
// exception, a message under the wrong key must never decrypt, and nothing
// short of a proven association may reach the vault

vi.mock('electron', () => ({
    app: { getPath: () => '/nonexistent', on: () => {} },
    ipcMain: { on: () => {}, handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../electron/src/ipc-guard', () => ({ handle: () => {}, on: () => {}, isTrustedSender: () => true }));
vi.mock('../../electron/src/window', () => ({
    getVaultWindows: () => [],
    onVaultWindowsChanged: () => {},
}));

const { handleEnvelope, handleDecryptedMessage } = await import('../../electron/src/browser-integration');
type Session = Parameters<typeof handleDecryptedMessage>[2];

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64ish = fc.oneof(anyText(), bytes(64).map(b64), fc.constant(''), fc.constant(undefined), anyValue());

const ERROR_CANNOT_DECRYPT = '2';
const ERROR_INCORRECT_ACTION = '11';
const ERROR_DATABASE_NOT_OPENED = '1';
const ERROR_ASSOCIATION_FAILED = '8';

// A client that completed the key exchange with a fresh server session
async function pairedClient() {
    const sessions = new Map<string, Session>();
    const client = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);
    const reply = await handleEnvelope({ action: 'change-public-keys', clientID: 'c', publicKey: b64(client.publicKey), nonce: b64(nonce) }, sessions);
    const serverKey = new Uint8Array(Buffer.from(reply.publicKey, 'base64'));
    const encrypt = (inner: unknown) => {
        const n = nacl.randomBytes(24);
        // JSON has no undefined; a client sending "nothing" sends null
        const box = nacl.box(new Uint8Array(Buffer.from(JSON.stringify(inner) ?? 'null')), n, serverKey, client.secretKey);
        return { message: b64(box), nonce: b64(n) };
    };
    return { sessions, encrypt, serverKey, client };
}

describe('browser protocol under fuzz', () => {
    it('any envelope shape yields an answer object, never an exception', async () => {
        const envelope = fc.oneof(
            anyValue(),
            fc.record({ action: b64ish, clientID: b64ish, publicKey: b64ish, nonce: b64ish, message: b64ish }, { requiredKeys: [] }),
        );
        await fc.assert(fc.asyncProperty(envelope, async (env) => {
            const sessions = new Map<string, Session>();
            const reply = await handleEnvelope(env, sessions);
            expect(typeof reply).toBe('object');
            expect(reply.success === 'true' && reply.message !== undefined).toBe(false);
        }), settings());
    });

    it('a message under any key but the paired one never decrypts', async () => {
        const paired = await pairedClient();
        await fc.assert(fc.asyncProperty(bytes(200), fc.uint8Array({ minLength: 24, maxLength: 24 }), async (payload, nonce) => {
            const stranger = nacl.box.keyPair();
            const box = nacl.box(payload, nonce, paired.serverKey, stranger.secretKey);
            const reply = await handleEnvelope({ action: 'get-logins', clientID: 'c', message: b64(box), nonce: b64(nonce) }, paired.sessions);
            expect(reply.errorCode).toBe(ERROR_CANNOT_DECRYPT);
        }), settings());
    });

    it('any byte change to a valid ciphertext or nonce is refused', async () => {
        const paired = await pairedClient();
        await fc.assert(fc.asyncProperty(fc.nat(), fc.integer({ min: 1, max: 255 }), fc.boolean(), async (index, delta, hitNonce) => {
            const good = paired.encrypt({ action: 'get-databasehash' });
            const target = Buffer.from(hitNonce ? good.nonce : good.message, 'base64');
            target[index % target.length] = (target[index % target.length] + delta) & 0xff;
            const reply = await handleEnvelope({
                action: 'get-databasehash', clientID: 'c',
                message: hitNonce ? good.message : target.toString('base64'),
                nonce: hitNonce ? target.toString('base64') : good.nonce,
            }, paired.sessions);
            expect(reply.errorCode).toBe(ERROR_CANNOT_DECRYPT);
        }), settings());
    });

    it('a decrypted message of any shape is answered, and unknown actions are refused', async () => {
        const paired = await pairedClient();
        const inner = fc.oneof(anyValue(), fc.record({ action: fc.oneof(anyText(), fc.constantFrom('get-logins', 'set-login', 'get-totp', 'associate', 'test-associate', 'lock-database', 'generate-password', 'passkeys-get', 'passkeys-register', 'get-databasehash')), url: anyText(), uuid: anyText(), keys: anyValue(), key: anyText(), id: anyText() }, { requiredKeys: [] }));
        await fc.assert(fc.asyncProperty(inner, async (message) => {
            const sealed = paired.encrypt(message);
            const reply = await handleEnvelope({ action: 'fuzz', clientID: 'c', ...sealed }, paired.sessions);
            expect(typeof reply).toBe('object');
            // With no vault window open, nothing can succeed except the
            // actions that touch no vault; the vault-bound ones report that
            if (reply.errorCode !== undefined) {
                expect([ERROR_CANNOT_DECRYPT, ERROR_INCORRECT_ACTION, ERROR_DATABASE_NOT_OPENED, ERROR_ASSOCIATION_FAILED]).toContain(reply.errorCode);
            }
        }), settings());
    });

    it('the session-gated actions are refused on a session that never associated, whatever they carry', async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom('set-login', 'get-totp'), anyValue(), async (action, message) => {
            const session: Session = { clientPublicKey: nacl.box.keyPair().publicKey, keyPair: nacl.box.keyPair(), associated: false };
            const reply = await handleDecryptedMessage(action, message, session);
            expect(reply.errorCode).toBe(Number(ERROR_ASSOCIATION_FAILED));
            expect(session.associated).toBe(false);
        }), settings());
    });

    it('a failed associate never flips a session to associated', async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom('associate', 'test-associate'), anyValue(), async (action, message) => {
            const session: Session = { clientPublicKey: nacl.box.keyPair().publicKey, keyPair: nacl.box.keyPair(), associated: false };
            const reply = await handleDecryptedMessage(action, message, session);
            expect(reply.errorCode).toBeDefined();
            expect(session.associated).toBe(false);
        }), settings());
    });
});

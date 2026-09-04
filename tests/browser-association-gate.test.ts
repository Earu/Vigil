import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';

// get-totp and set-login carry no association key of their own: the extension
// sends only {action, uuid} and {action, url, login, password, ...}. KeePassXC
// gates both on session state (m_associated, set by associate/test-associate),
// and so must this, or any process that can reach the socket could read a
// one-time code or write an entry without ever proving it knows the database.

const ERROR_DATABASE_NOT_OPENED = 1;
const ERROR_ASSOCIATION_FAILED = 8;

// Captures the ipcMain listener the module registers, so a fake renderer can
// answer the requests askVaults forwards
let respond: ((event: unknown, payload: { id: number; result: unknown }) => void) | undefined;

vi.mock('electron', () => ({
    app: { getPath: () => '/nonexistent', on: () => {} },
    ipcMain: {
        on: (channel: string, listener: any) => {
            if (channel === 'browser-integration-response') respond = listener;
        },
        handle: () => {},
    },
    BrowserWindow: { getAllWindows: () => [] },
}));

// The sender check is covered by ipc-guard.test.ts; the fake renderer here
// is always the trusted one
vi.mock('../electron/src/ipc-guard', async () => {
    const { ipcMain } = await import('electron');
    return { handle: ipcMain.handle, on: ipcMain.on, isTrustedSender: () => true };
});

// What the fake renderer replies with, per test
let rendererReply: any = {};
let windows: any[] = [];

// Replies come back with the same sender identity that was asked: the main
// process drops a response from any other webContents
const fakeWindow = (webContentsId = 1) => ({
    webContents: {
        id: webContentsId,
        send: (_channel: string, request: { id: number }) => {
            queueMicrotask(() => respond?.({ sender: { id: webContentsId } }, { id: request.id, result: rendererReply }));
        },
    },
});

vi.mock('../electron/src/window', () => ({
    getVaultWindows: () => windows,
    onVaultWindowsChanged: () => {},
}));

const { handleDecryptedMessage, handleEnvelope, setupBrowserIntegration } =
    await import('../electron/src/browser-integration');
const Session = () => ({
    clientPublicKey: nacl.box.keyPair().publicKey,
    keyPair: nacl.box.keyPair(),
    associated: false,
});

// Registers the ipcMain response listener the fake renderer needs
setupBrowserIntegration();

beforeEach(() => {
    windows = [];
    rendererReply = {};
});

describe('association gate', () => {
    // With no vault window open askVaults answers DATABASE_NOT_OPENED, so that
    // code means the request got past the gate and ASSOCIATION_FAILED means it
    // did not. Distinguishes the two without standing up a whole fake vault
    describe.each(['get-totp', 'set-login'] as const)('%s', (action) => {
        it('is refused on a session that never associated', async () => {
            const result = await handleDecryptedMessage(action, { uuid: 'abc' }, Session());

            expect(result.errorCode).toBe(ERROR_ASSOCIATION_FAILED);
        });

        it('reaches the vault once the session is associated', async () => {
            const session = { ...Session(), associated: true };

            const result = await handleDecryptedMessage(action, { uuid: 'abc' }, session);

            expect(result.errorCode).toBe(ERROR_DATABASE_NOT_OPENED);
        });

        it('asks no renderer at all when refused', async () => {
            const asked: unknown[] = [];
            windows = [{ webContents: { send: (_c: string, r: unknown) => asked.push(r) } }];

            await handleDecryptedMessage(action, { uuid: 'abc' }, Session());

            expect(asked).toEqual([]);
        });
    });

    // These carry their own keys, or expose nothing worth gating, so the
    // session flag must not start refusing them
    it.each(['get-databasehash', 'get-logins', 'generate-password'] as const)(
        'does not gate %s on the session flag',
        async (action) => {
            const result = await handleDecryptedMessage(action, { url: 'https://x.test', keys: [] }, Session());

            expect(result.errorCode).not.toBe(ERROR_ASSOCIATION_FAILED);
        },
    );
});

describe('what sets the association flag', () => {
    it('associate marks the session associated when it succeeds', async () => {
        windows = [fakeWindow()];
        rendererReply = { hash: 'deadbeef', id: 'Vigil' };
        const session = Session();

        await handleDecryptedMessage('associate', { key: 'k', idKey: 'idk' }, session);

        expect(session.associated).toBe(true);
    });

    it('test-associate marks the session associated when it succeeds', async () => {
        windows = [fakeWindow()];
        rendererReply = { hash: 'deadbeef', id: 'Vigil' };
        const session = Session();

        await handleDecryptedMessage('test-associate', { id: 'Vigil', key: 'k' }, session);

        expect(session.associated).toBe(true);
    });

    it('a rejected test-associate leaves the session unassociated', async () => {
        windows = [fakeWindow()];
        rendererReply = { errorCode: ERROR_ASSOCIATION_FAILED };
        const session = Session();

        await handleDecryptedMessage('test-associate', { id: 'Vigil', key: 'wrong' }, session);

        expect(session.associated).toBe(false);
    });

    it('ignores an answer from a window that was not asked', async () => {
        // Preload exposes browserIntegrationRespond to every window, so a
        // compromised renderer could try to approve a consent request that
        // belongs to another vault's window. Only the asked sender counts;
        // the forged approval must not associate the session
        windows = [{
            webContents: {
                id: 1,
                send: (_channel: string, request: { id: number }) => {
                    queueMicrotask(() => {
                        // The imposter (a different webContents) races in an
                        // approval before the real window denies
                        respond?.({ sender: { id: 99 } }, { id: request.id, result: { hash: 'deadbeef', id: 'Vigil' } });
                        respond?.({ sender: { id: 1 } }, { id: request.id, result: { errorCode: ERROR_ASSOCIATION_FAILED } });
                    });
                },
            },
        }];
        const session = Session();

        const result = await handleDecryptedMessage('associate', { key: 'k', idKey: 'idk' }, session);

        expect(result.errorCode).toBe(ERROR_ASSOCIATION_FAILED);
        expect(session.associated).toBe(false);
    });

    it('a failed associate does not open the door to get-totp', async () => {
        windows = [fakeWindow()];
        rendererReply = { errorCode: ERROR_ASSOCIATION_FAILED };
        const session = Session();

        await handleDecryptedMessage('associate', { key: 'k', idKey: 'idk' }, session);
        const totp = await handleDecryptedMessage('get-totp', { uuid: 'abc' }, session);

        expect(totp.errorCode).toBe(ERROR_ASSOCIATION_FAILED);
    });
});

describe('session scope', () => {
    const handshake = (clientID: string) => ({
        action: 'change-public-keys',
        clientID,
        publicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),
        nonce: Buffer.from(nacl.randomBytes(24)).toString('base64'),
    });

    it('gives each connection its own sessions', async () => {
        const connectionA = new Map<string, any>();
        const connectionB = new Map<string, any>();

        await handleEnvelope(handshake('shared-id'), connectionA);
        connectionA.get('shared-id')!.associated = true;

        // Same clientID over a different socket must not inherit the standing
        // the first connection earned
        await handleEnvelope(handshake('shared-id'), connectionB);
        expect(connectionB.get('shared-id')!.associated).toBe(false);
        expect(connectionA.get('shared-id')!.associated).toBe(true);
    });

    it('caps how many sessions one connection can open', async () => {
        const sessions = new Map<string, any>();
        for (let i = 0; i < 200; i++) {
            await handleEnvelope(handshake(`client-${i}`), sessions);
        }
        expect(sessions.size).toBeLessThanOrEqual(32);
        // The most recent handshakes are the ones kept
        expect(sessions.has('client-199')).toBe(true);
        expect(sessions.has('client-0')).toBe(false);
    });

    it('re-handshaking one clientID replaces it rather than filling the cap', async () => {
        const sessions = new Map<string, any>();
        for (let i = 0; i < 200; i++) {
            await handleEnvelope(handshake('steady'), sessions);
        }
        expect(sessions.size).toBe(1);
    });

    it('refuses an encrypted message on a connection that never handshook', async () => {
        const result = await handleEnvelope(
            { action: 'get-logins', clientID: 'unknown', message: 'x', nonce: 'y' },
            new Map());
        expect(result.errorCode).toBe(String(2));
    });
});

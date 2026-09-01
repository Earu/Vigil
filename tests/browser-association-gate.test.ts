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

// What the fake renderer replies with, per test
let rendererReply: any = {};
let windows: any[] = [];

const fakeWindow = () => ({
    webContents: {
        send: (_channel: string, request: { id: number }) => {
            queueMicrotask(() => respond?.(null, { id: request.id, result: rendererReply }));
        },
    },
});

vi.mock('../electron/src/window', () => ({
    getVaultWindows: () => windows,
    onVaultWindowsChanged: () => {},
}));

const { handleDecryptedMessage, setupBrowserIntegration } =
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

    it('a failed associate does not open the door to get-totp', async () => {
        windows = [fakeWindow()];
        rendererReply = { errorCode: ERROR_ASSOCIATION_FAILED };
        const session = Session();

        await handleDecryptedMessage('associate', { key: 'k', idKey: 'idk' }, session);
        const totp = await handleDecryptedMessage('get-totp', { uuid: 'abc' }, session);

        expect(totp.errorCode).toBe(ERROR_ASSOCIATION_FAILED);
    });
});

import { describe, it, expect, vi, beforeAll } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const updaterEvents = new Map<string, (info: unknown) => void>();
const downloadUpdate = vi.fn(async () => []);
const sent: unknown[] = [];

vi.mock('electron', () => ({
    app: { isPackaged: true, getPath: () => '/tmp' },
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_: string, status: unknown) => sent.push(status) } }] },
    net: { fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) },
}));
vi.mock('../electron/src/ipc-guard', () => ({
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}));
vi.mock('../electron/src/update-signature', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../electron/src/update-signature')>()),
    verifyUpdateMetadata: () => ({ ok: true }),
}));
vi.mock('electron-updater', () => ({
    autoUpdater: {
        on: (event: string, listener: (info: unknown) => void) => updaterEvents.set(event, listener),
        checkForUpdates: async () => null,
        downloadUpdate,
    },
}));

beforeAll(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.useFakeTimers();
    const { setupAutoUpdater } = await import('../electron/src/updater');
    setupAutoUpdater();
});

const status = () => handlers.get('get-update-status')!();

describe('update consent', () => {
    it('refuses to download before an update has been offered', async () => {
        expect(await handlers.get('download-update')!()).toEqual({ state: 'idle' });
        expect(downloadUpdate).not.toHaveBeenCalled();
    });

    it('offers a verified update without downloading it', async () => {
        updaterEvents.get('update-available')!({ version: '9.9.9', files: [] });
        await vi.waitFor(() => expect(status()).toEqual({ state: 'available', version: '9.9.9' }));

        expect(sent).toContainEqual({ state: 'available', version: '9.9.9' });
        expect(downloadUpdate).not.toHaveBeenCalled();
    });

    it('downloads once the user accepts, and only once', async () => {
        expect(await handlers.get('download-update')!()).toEqual({ state: 'downloading', version: '9.9.9' });
        await handlers.get('download-update')!();

        expect(downloadUpdate).toHaveBeenCalledTimes(1);
    });
});

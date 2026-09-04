import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pathToFileURL } from 'url';

// Every IPC channel is registered through ipc-guard, which admits only the
// main frame of one of this app's windows showing the app's own document.
// Nothing else can reach the bridge today; these pin down that a handler
// added later, or a frame that one day loads something else, is refused
// without anyone having to remember the check.

const INDEX_URL = 'vigil://app/index.html';

const handlers = new Map<string, (...args: any[]) => any>();
const listeners = new Map<string, (...args: any[]) => any>();
const fromWebContents = vi.fn();
const devBuild = vi.fn(() => false);

vi.mock('electron', () => ({
    ipcMain: {
        handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn); },
        on: (channel: string, fn: (...args: any[]) => any) => { listeners.set(channel, fn); },
    },
    BrowserWindow: { fromWebContents: (...args: any[]) => fromWebContents(...args) },
}));

vi.mock('../electron/src/utils', () => ({
    isDevBuild: () => devBuild(),
}));

const { isTrustedSender, handle, on } = await import('../electron/src/ipc-guard');

// An event as the trusted renderer produces it; overrides make it something else
const makeEvent = (overrides: { frameUrl?: string; subframe?: boolean; noFrame?: boolean } = {}) => {
    const mainFrame = { url: overrides.frameUrl ?? INDEX_URL };
    const sender = { mainFrame, id: 1 };
    return {
        sender,
        senderFrame: overrides.noFrame ? null : overrides.subframe ? { url: mainFrame.url } : mainFrame,
    } as any;
};

beforeEach(() => {
    handlers.clear();
    listeners.clear();
    fromWebContents.mockReset().mockReturnValue({ id: 'window' });
    devBuild.mockReturnValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('isTrustedSender', () => {
    it('admits the main frame of an app window showing the packaged document', () => {
        expect(isTrustedSender(makeEvent())).toBe(true);
    });

    it('admits the document with a hash or query, since routers add those', () => {
        expect(isTrustedSender(makeEvent({ frameUrl: `${INDEX_URL}#/entries?x=1` }))).toBe(true);
    });

    it('refuses a frame inside the page', () => {
        expect(isTrustedSender(makeEvent({ subframe: true }))).toBe(false);
    });

    it('refuses an event whose frame is already gone', () => {
        expect(isTrustedSender(makeEvent({ noFrame: true }))).toBe(false);
    });

    it('refuses a webContents that is not one of the app windows', () => {
        fromWebContents.mockReturnValue(null);
        expect(isTrustedSender(makeEvent())).toBe(false);
    });

    it('refuses any other document, on the app scheme or off it', () => {
        expect(isTrustedSender(makeEvent({ frameUrl: 'https://example.com/' }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'http://localhost:5173/' }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'vigil://app/other.html' }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'vigil://app/' }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'vigil://evil/index.html' }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'https://app/index.html' }))).toBe(false);
        // The document the app used to load from; a file: page is
        // same-origin with every file the user can read
        expect(isTrustedSender(makeEvent({ frameUrl: pathToFileURL('/opt/vigil/app/dist/index.html').href }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'not a url' }))).toBe(false);
    });

    it('in a dev build admits the Vite origin and nothing else', () => {
        devBuild.mockReturnValue(true);
        expect(isTrustedSender(makeEvent({ frameUrl: 'http://localhost:5173/' }))).toBe(true);
        expect(isTrustedSender(makeEvent({ frameUrl: 'http://localhost:5173/some/route' }))).toBe(true);
        expect(isTrustedSender(makeEvent({ frameUrl: 'http://localhost:5174/' }))).toBe(false);
        expect(isTrustedSender(makeEvent({ frameUrl: 'http://evil.localhost:5173/' }))).toBe(false);
        expect(isTrustedSender(makeEvent())).toBe(false);
    });
});

describe('handle', () => {
    it('runs the handler for the trusted renderer with its arguments', async () => {
        const inner = vi.fn(async (_event: unknown, a: number, b: number) => a + b);
        handle('sum', inner);
        await expect(handlers.get('sum')!(makeEvent(), 2, 3)).resolves.toBe(5);
        expect(inner).toHaveBeenCalledTimes(1);
    });

    it('rejects an untrusted sender without reaching the handler', async () => {
        const inner = vi.fn();
        handle('secret', inner);
        expect(() => handlers.get('secret')!(makeEvent({ subframe: true }), 'x')).toThrow('Untrusted IPC sender');
        expect(inner).not.toHaveBeenCalled();
    });
});

describe('on', () => {
    it('delivers the trusted renderer message', () => {
        const inner = vi.fn();
        on('note', inner);
        listeners.get('note')!(makeEvent(), 'hello');
        expect(inner).toHaveBeenCalledWith(expect.anything(), 'hello');
    });

    it('drops an untrusted sender message silently', () => {
        const inner = vi.fn();
        on('note', inner);
        fromWebContents.mockReturnValue(null);
        listeners.get('note')!(makeEvent(), 'hello');
        expect(inner).not.toHaveBeenCalled();
    });
});

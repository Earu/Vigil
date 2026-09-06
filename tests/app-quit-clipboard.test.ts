import { describe, it, expect, beforeEach, vi } from 'vitest';

// Quit path of the clipboard clear. A quit with a vault secret on the
// clipboard is held back for the async clear and re-issued; a quit with
// nothing of the vault's outstanding passes straight through. The regression
// this pins: a cancelled quit (a window's close handler asks about unsaved
// changes and the user picks Cancel) must not exhaust the clear, or a secret
// copied afterwards survives the next, successful quit on the OS clipboard.

let board = '';
let clears = 0;

class FakeClipboardItem {
    constructor(public readonly items: Record<string, string>) {}
}

type BeforeQuitHandler = (event: { preventDefault: () => void }) => void;
let appHandlers: Record<string, BeforeQuitHandler[]> = {};
const quit = vi.fn();

vi.mock('electron', () => ({
    ClipboardItem: FakeClipboardItem,
    clipboard: {
        write: async (items: FakeClipboardItem[]) => { board = items[0].items['text/plain']; },
        writeText: async (text: string) => { board = text; },
        readText: async () => board,
        clear: () => { clears++; board = ''; },
    },
    app: {
        on: (name: string, handler: BeforeQuitHandler) => {
            (appHandlers[name] ??= []).push(handler);
        },
        quit,
        setName: vi.fn(),
        setPath: vi.fn(),
        getPath: () => '/tmp/fake',
        requestSingleInstanceLock: () => true,
        // Never resolves: none of the window creation runs
        whenReady: () => new Promise<void>(() => {}),
        isReady: () => false,
        commandLine: { appendSwitch: vi.fn(), hasSwitch: () => false },
        isPackaged: false,
        exit: vi.fn(),
    },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    BrowserWindow: { getAllWindows: () => [] },
    powerMonitor: { on: vi.fn() },
    session: {
        defaultSession: {
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
        },
    },
}));

vi.mock('../electron/src/window', () => ({
    createWindow: vi.fn(),
    findVaultWindow: vi.fn(),
    findIdleWindow: vi.fn(),
    focusWindow: vi.fn(),
}));
vi.mock('../electron/src/ipc', () => ({ setupIpcHandlers: vi.fn() }));
vi.mock('../electron/src/updater', () => ({ setupAutoUpdater: vi.fn() }));
vi.mock('../electron/src/browser-integration', () => ({ setupBrowserIntegration: vi.fn() }));
vi.mock('../electron/src/menu', () => ({ applyApplicationMenu: vi.fn() }));
vi.mock('../electron/src/file-operations', () => ({ handleFileOpen: vi.fn() }));
vi.mock('../electron/src/logger', () => ({ setupLogging: vi.fn() }));

// The agent client has tests of its own against a real ssh-agent; here only
// the quit hold around it is under test
const hasKeysToRelease = vi.fn(() => false);
const releaseAllWindows = vi.fn(async (): Promise<string[]> => []);
vi.mock('../electron/src/ssh-agent', () => ({
    hasKeysToRelease: () => hasKeysToRelease(),
    releaseAllWindows: () => releaseAllWindows(),
}));

// The clipboard module stays real: app-main's before-quit handler driving the
// real clear is the unit under test
async function boot() {
    const clip = await import('../electron/src/clipboard');
    await import('../electron/app-main');
    return { clip, beforeQuit: appHandlers['before-quit'][0] };
}

beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    board = '';
    clears = 0;
    appHandlers = {};
    quit.mockClear();
    hasKeysToRelease.mockReset().mockReturnValue(false);
    releaseAllWindows.mockReset().mockResolvedValue([]);
});

describe('ssh keys on quit', () => {
    // A vault's keys leave the agent when the vault closes, but a quit closes
    // every window without waiting for their socket round trips. The quit is
    // held for one release of everything, then re-issued
    it('holds the quit until the keys are out of the agent', async () => {
        const { beforeQuit } = await boot();
        let finish!: () => void;
        hasKeysToRelease.mockReturnValue(true);
        releaseAllWindows.mockImplementation(() => new Promise(resolve => { finish = () => resolve(['SHA256:abc']); }));

        const event = { preventDefault: vi.fn() };
        beforeQuit(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(releaseAllWindows).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setImmediate(resolve));
        expect(quit).not.toHaveBeenCalled();

        finish();
        await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));

        // The release emptied the registry, so the re-issued quit passes
        hasKeysToRelease.mockReturnValue(false);
        const again = { preventDefault: vi.fn() };
        beforeQuit(again);
        expect(again.preventDefault).not.toHaveBeenCalled();
    });

    it('does not let an agent that stopped answering hold the quit forever', async () => {
        const { beforeQuit } = await boot();
        vi.useFakeTimers();
        hasKeysToRelease.mockReturnValue(true);
        releaseAllWindows.mockImplementation(() => new Promise(() => { /* never */ }));

        beforeQuit({ preventDefault: vi.fn() });
        await vi.advanceTimersByTimeAsync(4999);
        expect(quit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(quit).toHaveBeenCalledTimes(1);
    });

    it('clears the clipboard and releases the keys under the same hold', async () => {
        const { clip, beforeQuit } = await boot();
        await clip.copySecret('secret-1');
        hasKeysToRelease.mockReturnValue(true);

        const event = { preventDefault: vi.fn() };
        beforeQuit(event);
        await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(releaseAllWindows).toHaveBeenCalledTimes(1);
        expect(board).toBe('');
    });
});

describe('clipboard on quit', () => {
    it('clears a secret copied after an earlier quit was cancelled', async () => {
        const { clip, beforeQuit } = await boot();

        // First quit: held back, cleared, re-issued. This part works
        await clip.copySecret('secret-1');
        const firstQuit = { preventDefault: vi.fn() };
        beforeQuit(firstQuit);
        await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
        expect(firstQuit.preventDefault).toHaveBeenCalledTimes(1);
        expect(board).toBe('');

        // The re-issued quit gets cancelled (unsaved changes prompt, user
        // picks Cancel): nothing more happens, the process stays alive

        // A new secret is copied, then the user quits again
        await clip.copySecret('secret-2');
        const secondQuit = { preventDefault: vi.fn() };
        beforeQuit(secondQuit);

        // The clear must run again before this quit goes through
        await vi.waitFor(() => expect(board).toBe(''));
        expect(secondQuit.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('leaves a value the user copied themselves alone and lets the quit through', async () => {
        const { beforeQuit } = await boot();

        // Nothing of the vault's is outstanding, so the quit is not even
        // held back for a clear
        board = 'a shopping list';
        const event = { preventDefault: vi.fn() };
        beforeQuit(event);
        await new Promise(resolve => setImmediate(resolve));
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(quit).not.toHaveBeenCalled();
        expect(board).toBe('a shopping list');
        expect(clears).toBe(0);
    });
});

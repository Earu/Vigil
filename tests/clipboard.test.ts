import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A copied secret is cleared from the clipboard after a countdown, and the
// countdown belongs to the app rather than to whichever view started it: the
// generator modal is normally closed right after its copy button is pressed.
let board = '';
let cleared = 0;
let readThrows = false;
const toasts: Array<{ message: string; type: string }> = [];
let writeThrows = false;
// What the stand-in main process believes it put there
let ours: string | null = null;

const clipboard = {
    writeText: async (text: string) => {
        if (writeThrows) throw new Error('denied');
        board = text;
    },
    readText: async () => {
        if (readThrows) throw new Error('denied');
        return board;
    },
};

vi.stubGlobal('navigator', { clipboard });
// Stands in for electron/src/clipboard, which owns the write, the record of
// which value is the vault's, the clear, and the countdown that triggers it;
// see clipboard-main.test.ts. The countdown here matters: the renderer's own
// timer only draws the badge, so a test that expects the board cleared is
// exercising this stand-in timer the way the app exercises the main-process
// one
let mainTimer: ReturnType<typeof setTimeout> | null = null;
let lastClearSeconds: number | undefined;

const mainClear = async () => {
    if (mainTimer) {
        clearTimeout(mainTimer);
        mainTimer = null;
    }
    if (ours !== null && board !== ours && !readThrows) {
        ours = null;
        return { success: true };
    }
    ours = null;
    cleared++;
    board = '';
    return { success: true };
};

vi.stubGlobal('window', {
    electron: {
        copySecret: async (text: string, clearSeconds?: number) => {
            if (writeThrows) return { success: false, error: 'denied' };
            board = text;
            ours = text;
            lastClearSeconds = clearSeconds;
            if (mainTimer) clearTimeout(mainTimer);
            mainTimer = setTimeout(() => { void mainClear(); }, (clearSeconds ?? 20) * 1000);
            return { success: true };
        },
        clearClipboard: async () => mainClear(),
    },
    showToast: (toast: { message: string; type: string }) => toasts.push(toast),
});

const { ClipboardService } = await import('../src/services/ClipboardService');
const { userSettingsService, DEFAULT_CLIPBOARD_CLEAR_SECONDS } = await import('../src/services/UserSettingsService');
const CLIPBOARD_CLEAR_SECONDS = DEFAULT_CLIPBOARD_CLEAR_SECONDS;

// Run out the countdown; the clear itself is async, so let microtasks drain
const runOut = async (seconds = CLIPBOARD_CLEAR_SECONDS) => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
    await Promise.resolve();
};

beforeEach(() => {
    vi.useFakeTimers();
    board = '';
    cleared = 0;
    readThrows = false;
    writeThrows = false;
    ours = null;
    toasts.length = 0;
    lastClearSeconds = undefined;
    if (mainTimer) {
        clearTimeout(mainTimer);
        mainTimer = null;
    }
});

afterEach(() => {
    ClipboardService.clearNow();
    vi.useRealTimers();
});

describe('clipboard countdown', () => {
    it('clears a copied secret once the countdown runs out', async () => {
        await ClipboardService.copy('hunter2', 'Password', 'entry:a:Password');
        expect(board).toBe('hunter2');
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: CLIPBOARD_CLEAR_SECONDS, totalSeconds: CLIPBOARD_CLEAR_SECONDS, label: 'Password', source: 'entry:a:Password' });

        await runOut(CLIPBOARD_CLEAR_SECONDS - 1);
        expect(board).toBe('hunter2');
        expect(ClipboardService.getSnapshot().secondsLeft).toBe(1);

        await runOut(1);
        expect(cleared).toBe(1);
        expect(board).toBe('');
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: 0, totalSeconds: 0, label: '', source: '' });
    });

    it('restarts the countdown on a second copy instead of inheriting the old one', async () => {
        await ClipboardService.copy('first', 'Password', 'entry:a:Password');
        await runOut(CLIPBOARD_CLEAR_SECONDS - 2);
        await ClipboardService.copy('second', 'Username', 'entry:a:Username');
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: CLIPBOARD_CLEAR_SECONDS, totalSeconds: CLIPBOARD_CLEAR_SECONDS, label: 'Username', source: 'entry:a:Username' });

        // The old countdown would have fired by now
        await runOut(3);
        expect(cleared).toBe(0);
        expect(board).toBe('second');

        await runOut(CLIPBOARD_CLEAR_SECONDS - 3);
        expect(cleared).toBe(1);
    });

    it('clears immediately when the vault locks', async () => {
        await ClipboardService.copy('hunter2', 'Password', 'entry:a:Password');
        ClipboardService.clearNow();
        await Promise.resolve();

        expect(cleared).toBe(1);
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: 0, totalSeconds: 0, label: '', source: '' });

        // The countdown is gone, so nothing fires later
        await runOut();
        expect(cleared).toBe(1);
    });

    it('starts no countdown when the copy itself failed', async () => {
        writeThrows = true;
        expect(await ClipboardService.copy('hunter2', 'Password', 'entry:a:Password')).toBe(false);

        expect(ClipboardService.getSnapshot().secondsLeft).toBe(0);
        expect(toasts.at(-1)).toEqual({ message: 'Failed to copy to clipboard', type: 'error' });
    });

    it('attributes the countdown to the button that started it', async () => {
        // Every entry has a field called Password and so does the generator,
        // so a label cannot decide which button shows the countdown badge
        await ClipboardService.copy('generated', 'Password', 'generator');

        const { source } = ClipboardService.getSnapshot();
        expect(source).toBe('generator');
        expect(source).not.toBe('entry:a:Password');
        expect(source).not.toBe('entry:b:Password');
    });

    it('hands the countdown over when another button copies', async () => {
        await ClipboardService.copy('generated', 'Password', 'generator');
        await ClipboardService.copy('stored', 'Password', 'entry:a:Password');

        expect(ClipboardService.getSnapshot().source).toBe('entry:a:Password');
    });

    it('honours the configured clear duration', async () => {
        userSettingsService.setClipboardClearSeconds(5);
        try {
            await ClipboardService.copy('hunter2', 'Password', 'entry:a:Password');
            expect(ClipboardService.getSnapshot().secondsLeft).toBe(5);
            expect(ClipboardService.getSnapshot().totalSeconds).toBe(5);
            // The main process arms the real clear, so it must be told the
            // configured duration rather than assuming the default
            expect(lastClearSeconds).toBe(5);

            await runOut(5);
            expect(cleared).toBe(1);
        } finally {
            userSettingsService.setClipboardClearSeconds(DEFAULT_CLIPBOARD_CLEAR_SECONDS);
        }
    });

    it('clamps the configured duration to its bounds', () => {
        try {
            userSettingsService.setClipboardClearSeconds(1);
            expect(userSettingsService.getClipboardClearSeconds()).toBe(5);
            userSettingsService.setClipboardClearSeconds(9999);
            expect(userSettingsService.getClipboardClearSeconds()).toBe(600);
        } finally {
            userSettingsService.setClipboardClearSeconds(DEFAULT_CLIPBOARD_CLEAR_SECONDS);
        }
    });

    it('notifies subscribers on every tick', async () => {
        let notifications = 0;
        const unsubscribe = ClipboardService.subscribe(() => notifications++);

        await ClipboardService.copy('hunter2', 'Password', 'entry:a:Password');
        await runOut(3);
        unsubscribe();

        // One for the copy, one per elapsed second
        expect(notifications).toBe(4);
    });
});

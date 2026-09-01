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
// which value is the vault's and the clear; see clipboard-main.test.ts
vi.stubGlobal('window', {
    electron: {
        copySecret: async (text: string) => {
            if (writeThrows) return { success: false, error: 'denied' };
            board = text;
            ours = text;
            return { success: true };
        },
        clearClipboard: async () => {
            if (ours !== null && board !== ours && !readThrows) {
                ours = null;
                return { success: true };
            }
            ours = null;
            cleared++;
            board = '';
            return { success: true };
        },
    },
    showToast: (toast: { message: string; type: string }) => toasts.push(toast),
});

const { ClipboardService, CLIPBOARD_CLEAR_SECONDS } = await import('../src/services/ClipboardService');

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
});

afterEach(() => {
    ClipboardService.clearNow();
    vi.useRealTimers();
});

describe('clipboard countdown', () => {
    it('clears a copied secret once the countdown runs out', async () => {
        await ClipboardService.copy('hunter2', 'Password', 'entry:a:Password');
        expect(board).toBe('hunter2');
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: CLIPBOARD_CLEAR_SECONDS, label: 'Password', source: 'entry:a:Password' });

        await runOut(CLIPBOARD_CLEAR_SECONDS - 1);
        expect(board).toBe('hunter2');
        expect(ClipboardService.getSnapshot().secondsLeft).toBe(1);

        await runOut(1);
        expect(cleared).toBe(1);
        expect(board).toBe('');
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: 0, label: '', source: '' });
    });

    it('restarts the countdown on a second copy instead of inheriting the old one', async () => {
        await ClipboardService.copy('first', 'Password', 'entry:a:Password');
        await runOut(CLIPBOARD_CLEAR_SECONDS - 2);
        await ClipboardService.copy('second', 'Username', 'entry:a:Username');
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: CLIPBOARD_CLEAR_SECONDS, label: 'Username', source: 'entry:a:Username' });

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
        expect(ClipboardService.getSnapshot()).toEqual({ secondsLeft: 0, label: '', source: '' });

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

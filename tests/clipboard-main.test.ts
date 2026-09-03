import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Main-process side of the clipboard: it owns the write, the record of which
// value belongs to the vault, and the clear. The macOS markers matter because
// without them a copied password is recorded by clipboard managers and synced
// to the user's other devices over Universal Clipboard.
let board = '';
let readThrows = false;
let writeRejects = false;
let markerWriteRejects = false;
let markerWriteSwallowsText = false;
let clears = 0;
let lastWrite: Record<string, string> | null = null;

class FakeClipboardItem {
    constructor(public readonly items: Record<string, string>) {}
}

vi.mock('electron', () => ({
    ClipboardItem: FakeClipboardItem,
    clipboard: {
        write: async (items: FakeClipboardItem[]) => {
            if (markerWriteRejects) throw new Error('unsupported format');
            lastWrite = items[0].items;
            // A platform that accepts the formats but mangles the text
            board = markerWriteSwallowsText ? '' : items[0].items['text/plain'];
        },
        writeText: async (text: string) => {
            if (writeRejects) throw new Error('denied');
            lastWrite = { 'text/plain': text };
            board = text;
        },
        readText: async () => {
            if (readThrows) throw new Error('denied');
            return board;
        },
        clear: () => { clears++; board = ''; },
    },
}));

const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

const mod = await import('../electron/src/clipboard');

beforeEach(() => {
    board = '';
    readThrows = false;
    writeRejects = false;
    markerWriteRejects = false;
    markerWriteSwallowsText = false;
    clears = 0;
    lastWrite = null;
    mod.forgetSecret();
    setPlatform('darwin');
});

describe('copying a secret', () => {
    it('marks it concealed and transient on macOS', async () => {
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(board).toBe('hunter2');
        expect(Object.keys(lastWrite!)).toEqual([
            'text/plain',
            'electron application/osclipboard;format="org.nspasteboard.ConcealedType"',
            'electron application/osclipboard;format="org.nspasteboard.TransientType"',
        ]);
        // Markers are presence-only; the secret must not be written twice
        expect(Object.values(lastWrite!).filter(v => v === 'hunter2')).toHaveLength(1);
    });

    it('excludes it from clipboard history and cloud sync on Windows', async () => {
        setPlatform('win32');
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(Object.keys(lastWrite!)).toEqual([
            'text/plain',
            // The older convention, and the only one some clipboard managers check
            'electron application/osclipboard;format="Clipboard Viewer Ignore"',
            'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"',
            'electron application/osclipboard;format="CanIncludeInClipboardHistory"',
            'electron application/osclipboard;format="CanUploadToCloudClipboard"',
        ]);
        // The two history/cloud formats are read as a DWORD, so zero is the
        // value that means "no", and an empty marker would not say it
        const dword = lastWrite!['electron application/osclipboard;format="CanUploadToCloudClipboard"'] as unknown as Blob;
        expect(new Uint8Array(await dword.arrayBuffer())).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it('hints clipboard managers not to keep it on Linux', async () => {
        setPlatform('linux');
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(lastWrite!['electron application/osclipboard;format="x-kde-passwordManagerHint"'])
            .toBe('secret');
    });

    // An entry written with an empty string never reaches the platform
    // clipboard: Electron drops it, so no format is registered and the marker
    // protects nothing. Confirmed on Windows by enumerating the real clipboard
    // from another process, where the two markers written empty were absent
    // and the two carrying a DWORD were present
    it.each(['darwin', 'win32', 'linux'])('writes no empty marker on %s', async (platform) => {
        setPlatform(platform);
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        const empty = Object.entries(lastWrite!)
            .filter(([, value]) => value === '')
            .map(([key]) => key);
        expect(empty).toEqual([]);
    });

    it('writes plain text on a platform with no convention of its own', async () => {
        setPlatform('freebsd');
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(lastWrite).toEqual({ 'text/plain': 'hunter2' });
    });

    it('rewrites plain when the markers cost the text', async () => {
        // The markers are unverifiable on desktops this build cannot be run
        // on, so a copy that silently loses the text must still leave the
        // user something to paste
        markerWriteSwallowsText = true;
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(board).toBe('hunter2');
        expect(lastWrite).toEqual({ 'text/plain': 'hunter2' });
    });

    it('keeps the markers when the clipboard cannot be read back at all', async () => {
        readThrows = true;
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(Object.keys(lastWrite!)).toHaveLength(3);
    });

    it('still copies when the markers are refused', async () => {
        markerWriteRejects = true;
        expect(await mod.copySecret('hunter2')).toEqual({ success: true });
        expect(board).toBe('hunter2');
    });

    it('reports a failure rather than claiming a copy that did not happen', async () => {
        markerWriteRejects = true;
        writeRejects = true;
        expect(await mod.copySecret('hunter2')).toEqual({
            success: false, error: 'Failed to copy to clipboard',
        });
    });
});

describe('clearing', () => {
    it('takes back what the vault put there', async () => {
        await mod.copySecret('hunter2');
        await mod.clearClipboard();
        expect(clears).toBe(1);
        expect(board).toBe('');
    });

    it('leaves a value the user copied from somewhere else alone', async () => {
        await mod.copySecret('hunter2');
        board = 'a shopping list';
        await mod.clearClipboard();
        expect(clears).toBe(0);
        expect(board).toBe('a shopping list');
    });

    it('clears anyway when the clipboard cannot be read back', async () => {
        await mod.copySecret('hunter2');
        readThrows = true;
        await mod.clearClipboard();
        expect(clears).toBe(1);
    });

    it('does not clear twice for one copy', async () => {
        await mod.copySecret('hunter2');
        await mod.clearClipboard();
        await mod.clearClipboard();
        expect(clears).toBe(1);
    });
});

describe('the clear countdown', () => {
    // The countdown lives here so it survives the renderer that started the
    // copy: closing the last window on macOS quits nothing, and a countdown
    // owned by that window's renderer would leave the secret behind for good
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        mod.forgetSecret();
        vi.useRealTimers();
    });

    it('clears the secret when the countdown runs out, with no renderer involved', async () => {
        await mod.copySecret('hunter2', 20);
        await vi.advanceTimersByTimeAsync(19_000);
        expect(clears).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clears).toBe(1);
        expect(board).toBe('');
    });

    it('re-arms on a second copy instead of letting the first countdown fire early', async () => {
        await mod.copySecret('first', 20);
        await vi.advanceTimersByTimeAsync(15_000);
        await mod.copySecret('second', 20);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(clears).toBe(0);
        expect(board).toBe('second');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(clears).toBe(1);
    });

    it('an early clear spends the countdown', async () => {
        await mod.copySecret('hunter2', 20);
        await mod.clearClipboard();
        board = 'a shopping list';
        await vi.advanceTimersByTimeAsync(60_000);
        expect(clears).toBe(1);
        expect(board).toBe('a shopping list');
    });

    it('releasing ownership cancels the countdown', async () => {
        await mod.copySecret('hunter2', 20);
        mod.forgetSecret();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(clears).toBe(0);
        expect(board).toBe('hunter2');
    });

    it('falls back to the default duration when the renderer sends none', async () => {
        await mod.copySecret('hunter2');
        await vi.advanceTimersByTimeAsync(20_000);
        expect(clears).toBe(1);
    });

    // The duration crosses IPC from the renderer, so the clamp is the main
    // process's own: whatever arrives, the secret is cleared within the
    // bounds the settings UI enforces
    it.each([
        { sent: Number.NaN, firesAfter: 20_000 },
        { sent: Number.POSITIVE_INFINITY, firesAfter: 20_000 },
        { sent: -5, firesAfter: 5_000 },
        { sent: 1, firesAfter: 5_000 },
        { sent: 99_999_999, firesAfter: 600_000 },
    ])('clamps a hostile duration ($sent)', async ({ sent, firesAfter }) => {
        await mod.copySecret('hunter2', sent);
        await vi.advanceTimersByTimeAsync(firesAfter - 1_000);
        expect(clears).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clears).toBe(1);
    });
});

describe('quitting', () => {
    it('takes the secret back when the countdown never got to finish', async () => {
        await mod.copySecret('hunter2');
        await mod.clearOnQuit();
        expect(clears).toBe(1);
        expect(board).toBe('');
    });

    it('touches nothing when the vault has no secret outstanding', async () => {
        board = 'something the user copied';
        await mod.clearOnQuit();
        expect(clears).toBe(0);
        expect(board).toBe('something the user copied');
    });

    it('leaves a value copied after the vault released ownership', async () => {
        await mod.copySecret('hunter2');
        await mod.clearClipboard();
        board = 'a shopping list';
        await mod.clearOnQuit();
        expect(board).toBe('a shopping list');
    });
});

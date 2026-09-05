import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { watchVault, unwatchWindow, watchedCount, VAULT_CHANGED_CHANNEL, WatchTarget } from '../electron/src/vault-watcher';

// The watcher turns a burst of directory events into one "the file is now
// these bytes" message to the window that has the vault open. Everything
// below drives it through an injected watch function; the last case uses the
// real fs.watch to prove the directory-plus-basename approach survives the
// rename replacement every save (Vigil's or a sync client's) performs.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-watch-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// The watcher hashes and stats the file after its debounce timer fires, so a
// fixed sleep races real I/O on a loaded machine. Positive assertions wait
// for the send; the "nothing arrived" ones keep their fixed window
const until = async (ready: () => boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!ready() && Date.now() < deadline) await sleep(5);
};
const untilSent = (win: { sent: unknown[] }, count: number) => until(() => win.sent.length >= count);
// readFile the test settles by hand, in call order, so a test can decide when
// a read fails or succeeds instead of assuming how long real I/O takes
const controlledReads = () => {
    const pending: Array<{ resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];
    const readFile = () => new Promise<Buffer>((resolve, reject) => { pending.push({ resolve, reject }); });
    return { readFile, pending };
};
const fakeStat = async () => ({ mtimeMs: 1 }) as fs.Stats;
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

let counter = 0;
function newVault(contents = 'v1'): string {
    const file = path.join(tmpRoot, `vault-${counter++}.kdbx`);
    fs.writeFileSync(file, contents);
    return file;
}

function fakeWindow(): WatchTarget & { sent: unknown[][]; destroyed: boolean } {
    const win = {
        destroyed: false,
        sent: [] as unknown[][],
        isDestroyed() { return win.destroyed; },
        webContents: { send(channel: string, payload: unknown) { win.sent.push([channel, payload]); } },
    };
    return win;
}

// A stand-in FSWatcher: the test fires events by calling the captured listener
class FakeWatcher extends EventEmitter {
    closed = false;
    close(): void { this.closed = true; }
}

function fakeWatch() {
    const state: { dir?: string; listener?: (type: string, name: string | Buffer | null) => void; watcher: FakeWatcher } = {
        watcher: new FakeWatcher(),
    };
    const watch = (dir: string, listener: (type: string, name: string | Buffer | null) => void) => {
        state.dir = dir;
        state.listener = listener;
        return state.watcher as unknown as fs.FSWatcher;
    };
    const fire = (name: string | null) => state.listener!('rename', name);
    return { watch, fire, state };
}

const DEBOUNCE = 30;
const windows: WatchTarget[] = [];
afterEach(() => {
    for (const win of windows) unwatchWindow(win);
    windows.length = 0;
    expect(watchedCount()).toBe(0);
});

function watch(win: WatchTarget, file: string, deps: Parameters<typeof watchVault>[2]) {
    windows.push(win);
    watchVault(win, file, { debounceMs: DEBOUNCE, ...deps });
}

describe('a change to the vault file', () => {
    it('reaches the window once, with the hash and mtime of the bytes now on disk', async () => {
        const file = newVault('first');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        fs.writeFileSync(file, 'second');
        fire(path.basename(file));
        await untilSent(win, 1);

        expect(win.sent).toHaveLength(1);
        const [channel, payload] = win.sent[0] as [string, { path: string; hash: string; mtimeMs: number }];
        expect(channel).toBe(VAULT_CHANGED_CHANNEL);
        expect(payload.path).toBe(file);
        expect(payload.hash).toBe(sha256(Buffer.from('second')));
        expect(payload.mtimeMs).toBe(fs.statSync(file).mtimeMs);
    });

    it('collapses a burst of events into one notification', async () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        for (let i = 0; i < 6; i++) {
            fire(path.basename(file));
            await sleep(DEBOUNCE / 3);
        }
        expect(win.sent).toHaveLength(0);
        await untilSent(win, 1);
        expect(win.sent).toHaveLength(1);
    });

    it('carries the path the renderer knows, even when the file is a symlink', async () => {
        const target = newVault('linked');
        const link = path.join(tmpRoot, `link-${counter++}.kdbx`);
        fs.symlinkSync(target, link);
        const win = fakeWindow();
        const { watch: w, fire, state } = fakeWatch();
        watch(win, link, { watch: w });

        // The watch sits on the target's directory and name (here the same
        // directory, so the name is what shows the resolution happened)
        expect(state.dir).toBe(path.dirname(target));
        fire(path.basename(target));
        await untilSent(win, 1);
        expect(win.sent).toHaveLength(1);
        expect((win.sent[0][1] as { path: string }).path).toBe(link);
        expect((win.sent[0][1] as { hash: string }).hash).toBe(sha256(Buffer.from('linked')));
    });
});

describe('events that are not the vault', () => {
    it('ignores temp files and other names in the directory', async () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        fire(`.${path.basename(file)}.tmp-0123abcd`);
        fire('other.kdbx');
        fire(`${path.basename(file)}.bak`);
        await sleep(DEBOUNCE * 3);
        expect(win.sent).toHaveLength(0);
    });

    it('treats an event without a name as a candidate', async () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        fire(null);
        await untilSent(win, 1);
        expect(win.sent).toHaveLength(1);
    });
});

describe('lifecycle', () => {
    it('unwatching clears a pending notification and closes the watcher', async () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, fire, state } = fakeWatch();
        watch(win, file, { watch: w });

        fire(path.basename(file));
        unwatchWindow(win);
        await sleep(DEBOUNCE * 3);
        expect(win.sent).toHaveLength(0);
        expect(state.watcher.closed).toBe(true);
        expect(watchedCount()).toBe(0);
    });

    it('a second registration for the same window replaces the first', async () => {
        const first = newVault();
        const second = newVault();
        const win = fakeWindow();
        const a = fakeWatch();
        const b = fakeWatch();
        watch(win, first, { watch: a.watch });
        watch(win, second, { watch: b.watch });

        expect(a.state.watcher.closed).toBe(true);
        expect(watchedCount()).toBe(1);
        b.fire(path.basename(second));
        await untilSent(win, 1);
        expect(win.sent).toHaveLength(1);
        expect((win.sent[0][1] as { path: string }).path).toBe(second);
    });

    it('a window destroyed before the read lands gets nothing', async () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        fire(path.basename(file));
        win.destroyed = true;
        await sleep(DEBOUNCE * 3);
        expect(win.sent).toHaveLength(0);
    });

    it('a watch the OS refuses leaves the vault unwatched without throwing', () => {
        const file = newVault();
        const win = fakeWindow();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(() => watch(win, file, {
                watch: () => { throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' }); },
            })).not.toThrow();
            expect(watchedCount()).toBe(0);
            expect(error).toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });

    it('a watcher that errors after starting is closed rather than left half alive', () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, state } = fakeWatch();
        watch(win, file, { watch: w });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            state.watcher.emit('error', new Error('EPERM'));
        } finally {
            error.mockRestore();
        }
        expect(watchedCount()).toBe(0);
        expect(state.watcher.closed).toBe(true);
    });
});

describe('a file momentarily absent', () => {
    it('is read once more after another quiet period', async () => {
        const file = newVault('before');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        // The first half of a rename: the old file is gone, the new one is
        // not in place yet
        fs.unlinkSync(file);
        fire(path.basename(file));
        await sleep(DEBOUNCE * 1.5);
        expect(win.sent).toHaveLength(0);
        fs.writeFileSync(file, 'after');
        await untilSent(win, 1);
        expect(win.sent).toHaveLength(1);
        expect((win.sent[0][1] as { hash: string }).hash).toBe(sha256(Buffer.from('after')));
    });

    it('gives up after that single retry', async () => {
        const file = newVault();
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        const { readFile, pending } = controlledReads();
        watch(win, file, { watch: w, readFile, stat: fakeStat });

        fire(path.basename(file));
        await until(() => pending.length === 1);
        pending[0].reject(new Error('ENOENT'));
        await until(() => pending.length === 2);      // the one retry
        pending[1].reject(new Error('ENOENT'));
        await sleep(DEBOUNCE * 3);
        expect(pending).toHaveLength(2);              // no third attempt
        expect(win.sent).toHaveLength(0);
        // A later event starts over with a fresh retry budget
        fire(path.basename(file));
        await until(() => pending.length === 3);
        pending[2].resolve(Buffer.from('back'));
        await untilSent(win, 1);
        expect(win.sent).toHaveLength(1);
        expect((win.sent[0][1] as { hash: string }).hash).toBe(sha256(Buffer.from('back')));
    });
});

// A read the watcher started for one event can still be in flight when the
// next event arrives and schedules its own timer against the same pending
// entry. Whatever the old read then does with that entry must not orphan the
// new timer: it fires, finds nothing, and the newer change is never reported
describe('a change that arrives while an earlier read is in flight', () => {

    it('is not lost when the earlier read fails and had already used its retry', async () => {
        const file = newVault('v1');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        const { readFile, pending } = controlledReads();
        watch(win, file, { watch: w, readFile, stat: fakeStat });

        fire(path.basename(file));
        await until(() => pending.length === 1);
        pending[0].reject(new Error('ENOENT'));      // first read fails: one retry is scheduled
        await until(() => pending.length === 2);     // the retry's read is now in flight

        fire(path.basename(file));                   // a newer change, timer scheduled on the same entry
        await settled();
        pending[1].reject(new Error('ENOENT'));      // the retry fails too; the old code deletes the entry here
        await until(() => pending.length === 3, 500);
        expect(pending).toHaveLength(3);             // the newer timer must still get its read
        pending[2].resolve(Buffer.from('v3'));
        await untilSent(win, 1);
        expect((win.sent[0][1] as { hash: string }).hash).toBe(sha256(Buffer.from('v3')));
    });

    it('is not lost when the earlier read succeeds', async () => {
        const file = newVault('v1');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        const { readFile, pending } = controlledReads();
        watch(win, file, { watch: w, readFile, stat: fakeStat });

        fire(path.basename(file));
        await until(() => pending.length === 1);     // first read in flight
        fire(path.basename(file));                   // newer change scheduled meanwhile
        await settled();
        pending[0].resolve(Buffer.from('v1'));       // old code deletes the entry on success
        await untilSent(win, 1);
        await until(() => pending.length === 2, 500);
        expect(pending).toHaveLength(2);             // the newer timer still reads
        pending[1].resolve(Buffer.from('v2'));
        await untilSent(win, 2);
        expect((win.sent[1][1] as { hash: string }).hash).toBe(sha256(Buffer.from('v2')));
    });
});

describe('a conflict copy beside the vault', () => {
    it('is reported through its own callback with the copy path and hash, never as the vault', async () => {
        const file = newVault('main');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        const copies: Array<[string, string]> = [];
        watch(win, file, { watch: w, onConflictCopy: (copyPath, hash) => copies.push([copyPath, hash]) });

        const copyName = `${path.basename(file, '.kdbx')} 2.kdbx`;
        const copyPath = path.join(path.dirname(file), copyName);
        fs.writeFileSync(copyPath, 'from the phone');
        fire(copyName);
        await until(() => copies.length >= 1);

        expect(win.sent).toHaveLength(0);
        expect(copies).toEqual([[copyPath, sha256(Buffer.from('from the phone'))]]);
    });

    it('settles independently of the vault: both arrive when both change', async () => {
        const file = newVault('main');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        const copies: string[] = [];
        watch(win, file, { watch: w, onConflictCopy: (copyPath) => copies.push(copyPath) });

        const copyName = `${path.basename(file, '.kdbx')}-LAPTOP.kdbx`;
        fs.writeFileSync(path.join(path.dirname(file), copyName), 'onedrive');
        fire(path.basename(file));
        fire(copyName);
        await untilSent(win, 1);
        // The copy is hashed by its own notify; wait for that one too
        await until(() => copies.length >= 1);

        expect(win.sent).toHaveLength(1);
        expect(copies).toHaveLength(1);
    });

    it('is ignored when nobody asked to hear about copies', async () => {
        const file = newVault('main');
        const win = fakeWindow();
        const { watch: w, fire } = fakeWatch();
        watch(win, file, { watch: w });

        const copyName = `${path.basename(file, '.kdbx')} 2.kdbx`;
        fs.writeFileSync(path.join(path.dirname(file), copyName), 'x');
        fire(copyName);
        await sleep(DEBOUNCE * 3);
        expect(win.sent).toHaveLength(0);
    });
});

describe('with the real fs.watch', () => {
    it('sees a rename replacing the file, the way saves and sync clients write', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'real-'));
        const file = path.join(dir, 'vault.kdbx');
        fs.writeFileSync(file, 'v1');
        const win = fakeWindow();
        watch(win, file, { debounceMs: 100 });

        // Let the OS watch settle before the write
        await sleep(100);
        const tmp = path.join(dir, '.vault.kdbx.tmp-deadbeef');
        fs.writeFileSync(tmp, 'v2');
        fs.renameSync(tmp, file);

        const deadline = Date.now() + 5000;
        while (win.sent.length === 0 && Date.now() < deadline) await sleep(50);
        expect(win.sent.length).toBeGreaterThanOrEqual(1);
        expect((win.sent[0][1] as { hash: string }).hash).toBe(sha256(Buffer.from('v2')));
    }, 10000);
});

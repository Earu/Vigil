import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Follows the open vault's file on disk so a change made elsewhere (another
// machine through a sync client, another app) reaches the renderer while the
// vault is open, instead of surfacing at the next save as a merge of a
// version the user never saw. The renderer owns the merge (see
// KeepassDatabaseService.reloadExternalChanges); this only says "the bytes at
// this path are now these".
//
// The parent directory is watched and events filtered on the vault's name.
// Sync clients, and Vigil's own atomicWrite, replace the file by renaming a
// temp file over it; an inotify watch on the file itself follows the old
// inode and goes silent after the first replacement.
//
// Events come in bursts (a rename is two, a sync client may touch the file
// several times), so nothing is read until the file has been quiet for a
// moment, and one notification covers the burst.

export const VAULT_CHANGED_CHANNEL = 'vault-file-changed';
export const DEBOUNCE_MS = 1500;

export interface VaultChange {
    // The path as the renderer knows it (what it reported on vault-opened),
    // not the resolved one, so it can be compared to its own record
    path: string;
    hash: string;
    mtimeMs: number;
}

// The parts of a BrowserWindow this needs; tests hand in a stand-in
export interface WatchTarget {
    isDestroyed(): boolean;
    webContents: { send(channel: string, payload: unknown): void };
}

export interface WatchDeps {
    watch?: (dir: string, listener: (eventType: string, filename: string | Buffer | null) => void) => fs.FSWatcher;
    // Where the bytes actually land: a vault reached through a symlink is
    // written at the link's target (file-operations resolveWriteTarget)
    resolve?: (filePath: string) => string;
    debounceMs?: number;
    readFile?: (filePath: string) => Promise<Buffer>;
    stat?: (filePath: string) => Promise<{ mtimeMs: number }>;
}

interface ActiveWatch {
    watcher: fs.FSWatcher;
    timer: NodeJS.Timeout | null;
    // Whether the read after the quiet period may be retried once: a burst
    // can end with the file momentarily absent between the two halves of a
    // rename, and the event for the second half is what re-arms the timer
    retried: boolean;
}

const watches = new Map<WatchTarget, ActiveWatch>();

function defaultResolve(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

export function watchVault(win: WatchTarget, filePath: string, deps: WatchDeps = {}): void {
    unwatchWindow(win);

    const target = (deps.resolve ?? defaultResolve)(filePath);
    const dir = path.dirname(target);
    const name = path.basename(target);
    const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    const readFile = deps.readFile ?? (p => fs.promises.readFile(p));
    const stat = deps.stat ?? (p => fs.promises.stat(p));

    const notify = async (active: ActiveWatch) => {
        active.timer = null;
        let data: Buffer;
        let mtimeMs: number;
        try {
            [data, { mtimeMs }] = await Promise.all([readFile(target), stat(target)]);
        } catch {
            // Mid-rename, or gone for good. One retry after another quiet
            // period; a file that stays unreadable is the save path's problem
            if (!active.retried && watches.get(win) === active) {
                active.retried = true;
                active.timer = setTimeout(() => { void notify(active); }, debounceMs);
            }
            return;
        }
        active.retried = false;
        // Unwatched or replaced while the read was in flight
        if (watches.get(win) !== active || win.isDestroyed()) return;
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        const change: VaultChange = { path: filePath, hash, mtimeMs };
        win.webContents.send(VAULT_CHANGED_CHANNEL, change);
    };

    let active: ActiveWatch;
    try {
        const watcher = (deps.watch ?? fs.watch)(dir, (_eventType, filename) => {
            // Some platforms omit the name; then every event in the directory
            // is a candidate and the hash comparison in the renderer settles it
            if (filename !== null && filename !== undefined && filename.toString() !== name) return;
            const current = watches.get(win);
            if (!current) return;
            if (current.timer) clearTimeout(current.timer);
            current.timer = setTimeout(() => { void notify(current); }, debounceMs);
        });
        active = { watcher, timer: null, retried: false };
        watcher.on('error', (error) => {
            // A watch the OS drops (the directory went away, a mount gone) is
            // closed rather than left half alive; the save path still merges
            console.error('Vault watcher stopped:', error);
            if (watches.get(win) === active) unwatchWindow(win);
        });
    } catch (error) {
        // No inotify on this filesystem, or out of watch descriptors: the
        // vault stays unwatched and external changes surface at save time
        console.error('Could not watch the vault file:', error);
        return;
    }
    watches.set(win, active);
}

export function unwatchWindow(win: WatchTarget): void {
    const active = watches.get(win);
    if (!active) return;
    watches.delete(win);
    if (active.timer) clearTimeout(active.timer);
    try {
        active.watcher.close();
    } catch { /* already closed by the OS */ }
}

// Tests
export function watchedCount(): number {
    return watches.size;
}

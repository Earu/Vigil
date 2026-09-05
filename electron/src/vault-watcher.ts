import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isConflictCopyName, resolveVaultFile } from './conflict-copies';

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
// The same events show a sync client dropping a conflict copy of the vault
// beside it (conflict-copies.ts); those go to a separate callback.
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
    // A file beside the vault whose name says a sync client made it from
    // the vault appeared or changed; the caller decides what to do with it
    onConflictCopy?: (copyPath: string, hash: string) => void;
}

interface Pending {
    timer: NodeJS.Timeout | null;
    // Whether the read after the quiet period may be retried once: a burst
    // can end with the file momentarily absent between the two halves of a
    // rename, and the event for the second half is what re-arms the timer
    retried: boolean;
}

interface ActiveWatch {
    watcher: fs.FSWatcher;
    // One countdown per file name seen in the directory: the vault and each
    // conflict copy settle independently
    pending: Map<string, Pending>;
}

const watches = new Map<WatchTarget, ActiveWatch>();

export function watchVault(win: WatchTarget, filePath: string, deps: WatchDeps = {}): void {
    unwatchWindow(win);

    const target = (deps.resolve ?? resolveVaultFile)(filePath);
    const dir = path.dirname(target);
    const name = path.basename(target);
    const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    const readFile = deps.readFile ?? (p => fs.promises.readFile(p));
    const stat = deps.stat ?? (p => fs.promises.stat(p));

    const notify = async (active: ActiveWatch, fileName: string) => {
        const entry = active.pending.get(fileName);
        if (!entry) return;
        entry.timer = null;
        const file = path.join(dir, fileName);
        let data: Buffer;
        let mtimeMs: number;
        try {
            [data, { mtimeMs }] = await Promise.all([readFile(file), stat(file)]);
        } catch {
            // A newer event scheduled its own read while this one was in
            // flight; that read owns the entry now
            if (entry.timer) return;
            // Mid-rename, or gone for good. One retry after another quiet
            // period; a file that stays unreadable is the save path's problem
            if (!entry.retried && watches.get(win) === active) {
                entry.retried = true;
                entry.timer = setTimeout(() => { void notify(active, fileName); }, debounceMs);
            } else {
                active.pending.delete(fileName);
            }
            return;
        }
        // Same as above: a newer read is pending, and the entry stays for it
        if (!entry.timer) active.pending.delete(fileName);
        // Unwatched or replaced while the read was in flight
        if (watches.get(win) !== active || win.isDestroyed()) return;
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        if (fileName === name) {
            const change: VaultChange = { path: filePath, hash, mtimeMs };
            win.webContents.send(VAULT_CHANGED_CHANNEL, change);
        } else {
            deps.onConflictCopy?.(file, hash);
        }
    };

    const schedule = (active: ActiveWatch, fileName: string) => {
        let entry = active.pending.get(fileName);
        if (!entry) {
            entry = { timer: null, retried: false };
            active.pending.set(fileName, entry);
        }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { void notify(active, fileName); }, debounceMs);
    };

    let active: ActiveWatch;
    try {
        const watcher = (deps.watch ?? fs.watch)(dir, (_eventType, filename) => {
            const current = watches.get(win);
            if (!current) return;
            // Some platforms omit the name; then the vault itself is the
            // candidate and the hash comparison in the renderer settles it
            const seen = filename === null || filename === undefined ? name : filename.toString();
            if (seen === name) {
                schedule(current, name);
            } else if (deps.onConflictCopy && isConflictCopyName(name, seen)) {
                schedule(current, seen);
            }
        });
        active = { watcher, pending: new Map() };
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
    for (const entry of active.pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
    }
    active.pending.clear();
    try {
        active.watcher.close();
    } catch { /* already closed by the OS */ }
}

// Tests
export function watchedCount(): number {
    return watches.size;
}

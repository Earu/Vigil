import { app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Every save overwrites the vault in place, and the save path merges whatever
// it finds on disk before writing when the file changed underneath it. A merge
// that resolves badly therefore destroys the only copy there is; the atomic
// write protects against a crash mid-write, not against writing the wrong
// thing successfully. These are the copies to fall back to.
//
// Backups are spaced in time rather than taken on every save. A fault of this
// kind is noticed minutes or hours later, so a handful of copies all written
// within the same minute would every one of them be post-fault. With a
// minimum gap, keeping N copies covers at least N gaps of history.

const MIN_INTERVAL_MS = 30 * 60 * 1000;

export interface BackupOptions {
    enabled: boolean;
    keep: number;
}

export interface BackupRequest extends BackupOptions {
    // This save is about to destroy a version of the file it did not write:
    // an external change that was merged in, or one the user chose to
    // overwrite after the merge failed. The copy taken here is the only
    // record of that version, so it is taken whatever the interval says
    replacingExternalChanges?: boolean;
}

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = { enabled: true, keep: 5 };

// Backups live under userData rather than beside the vault. A kdbx file
// commonly sits in a synced folder, and dropping copies next to it would push
// every one of them through the sync client and clutter the directory the
// user actually looks at
//
// Keyed on the file itself, links followed, so a vault reached through a
// symlink and the same vault opened directly share one set of copies
export function backupDir(vaultPath: string): string {
    let resolved: string;
    try {
        resolved = fs.realpathSync(vaultPath);
    } catch {
        resolved = path.resolve(vaultPath);
    }
    const digest = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
    // Readable enough to recognise, with the digest keeping two vaults of the
    // same name apart
    const label = path.basename(resolved, path.extname(resolved))
        .replace(/[^\w.-]/g, '_')
        .slice(0, 40) || 'vault';
    return path.join(app.getPath('userData'), 'backups', `${label}-${digest}`);
}

// Millisecond resolution, so two copies taken in the same second cannot
// land on the same name and silently overwrite one another
function timestamp(date: Date): string {
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
        + pad(date.getMilliseconds(), 3);
}

// Names sort lexicographically into chronological order, which is what
// listBackups relies on. The tie breaker uses '_' rather than '-' because it
// sorts after '.', keeping a disambiguated name next to the one it clashed
// with instead of ahead of it.
//
// The exclusive create is the existence check: a name is free if the create
// succeeds, and a clash moves to the next suffix. Checking first and
// creating second would leave a window for another writer to take the name
async function writeFreshBackup(dir: string, base: string, stamp: string, data: Buffer, mode: number | undefined): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        const suffix = attempt === 0 ? '' : `_${attempt + 1}`;
        const candidate = path.join(dir, `${base}.${stamp}${suffix}.kdbx`);
        try {
            await fs.promises.writeFile(candidate, data, { mode: mode ?? 0o666, flag: 'wx' });
            return candidate;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    }
}

// Kept as .kdbx so recovering is just opening one. Timestamps sort
// lexicographically, so the newest is always last
export async function listBackups(vaultPath: string): Promise<string[]> {
    const dir = backupDir(vaultPath);
    try {
        const names = await fs.promises.readdir(dir);
        return names.filter(name => name.endsWith('.kdbx')).sort().map(name => path.join(dir, name));
    } catch {
        return [];
    }
}

async function prune(vaultPath: string, keep: number): Promise<void> {
    const existing = await listBackups(vaultPath);
    const doomed = existing.slice(0, Math.max(0, existing.length - Math.max(1, keep)));
    for (const file of doomed) {
        await fs.promises.unlink(file).catch(() => { /* already gone */ });
    }
}

// Never throws: a vault that cannot be backed up still has to be saveable,
// so every caller treats failure here as "carry on and write"
export async function backupBeforeWrite(vaultPath: string, options: BackupRequest): Promise<void> {
    if (!options.enabled) return;

    // One handle for the stat and the read, so the mode and the bytes are
    // taken from the same file rather than from whatever the path names at
    // each of two moments
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(vaultPath, 'r');
    } catch {
        // Nothing there yet; the first write to a path has nothing to preserve
        return;
    }
    let source: fs.Stats;
    let data: Buffer;
    try {
        source = await handle.stat();
        if (!source.isFile()) return;
        data = await handle.readFile();
    } finally {
        await handle.close();
    }

    const existing = await listBackups(vaultPath);
    const newest = existing[existing.length - 1];
    // Spacing is for the ordinary case. A save that replaces someone else's
    // version is the exact thing these copies exist to undo, and skipping it
    // would leave that version recorded nowhere
    if (newest && !options.replacingExternalChanges) {
        try {
            const { mtimeMs } = await fs.promises.stat(newest);
            if (Date.now() - mtimeMs < MIN_INTERVAL_MS) return;
        } catch { /* unreadable, so treat it as absent and take a fresh one */ }
    }

    // Owner-only on create: the copies inside are as sensitive as the vault
    const dir = backupDir(vaultPath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = path.basename(vaultPath, path.extname(vaultPath));

    // A copy of the database must not be readable by more people than the
    // database is, at any point: copyFile creates the target at the umask
    // default (0644 typically) and fixes it up after, leaving a window and
    // leaving 0644 for good if the chmod fails. Creating with the source's
    // mode means the umask can only ever subtract permissions; the chmod
    // then restores the exact mode
    const mode = process.platform === 'win32' ? undefined : source.mode & 0o777;
    const target = await writeFreshBackup(dir, name, timestamp(new Date()), data, mode);
    if (mode !== undefined) {
        await fs.promises.chmod(target, mode).catch(() => { /* created no wider than mode */ });
    }

    await prune(vaultPath, options.keep);
}

// Every copy here opens with the password the vault had when it was taken.
// After a master password change the user decides whether they stay
export async function purgeBackups(vaultPath: string): Promise<{ success: boolean; removed: number; error?: string }> {
    let removed = 0;
    try {
        for (const file of await listBackups(vaultPath)) {
            await fs.promises.unlink(file);
            removed++;
        }
        return { success: true, removed };
    } catch (error) {
        return { success: false, removed, error: error instanceof Error ? error.message : 'Failed to delete the backups' };
    }
}

export async function getBackupInfo(vaultPath: string): Promise<{
    directory: string;
    count: number;
    newest: string | null;
    totalBytes: number;
}> {
    const dir = backupDir(vaultPath);
    const files = await listBackups(vaultPath);
    let totalBytes = 0;
    let newest: string | null = null;
    for (const file of files) {
        try {
            const stat = await fs.promises.stat(file);
            totalBytes += stat.size;
            newest = new Date(stat.mtimeMs).toISOString();
        } catch { /* vanished between listing and stat */ }
    }
    return { directory: dir, count: files.length, newest, totalBytes };
}

// Opens the folder in the platform file manager. Created on demand so the
// button does nothing surprising before the first backup exists
export async function revealBackups(vaultPath: string): Promise<{ success: boolean; error?: string }> {
    const dir = backupDir(vaultPath);
    try {
        // Owner-only, the same as the write path creates it: the copies
        // that land here later are as sensitive as the vault
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        const error = await shell.openPath(dir);
        return error ? { success: false, error } : { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to open the folder' };
    }
}

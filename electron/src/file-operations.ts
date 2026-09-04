import { app, dialog, BrowserWindow } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { backupBeforeWrite, BackupRequest, DEFAULT_BACKUP_OPTIONS } from './backups';
import { grantPath, grantPathPersistent } from './path-authority';

const LAST_DB_PATH = path.join(app.getPath('userData'), 'last_database.json');

// Temp files are created exclusively ('wx') under a random name: 'w' would
// follow anything pre-planted at the path, so in a directory another local
// user can write to, a predictable name let a pre-placed symlink capture the
// bytes and, after the rename, the file itself. O_EXCL refuses to open a
// pre-existing path (symlinks included) and the random suffix makes planting
// one a lottery; EEXIST retries cover the lottery winner
async function openExclusiveTemp(tmpBase: string, mode: number): Promise<{ handle: fs.promises.FileHandle; tmpPath: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        const tmpPath = `${tmpBase}.tmp-${crypto.randomBytes(8).toString('hex')}`;
        try {
            return { handle: await fs.promises.open(tmpPath, 'wx', mode), tmpPath };
        } catch (error) {
            lastError = error;
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    }
    throw lastError;
}

// Sidecar files (the last-database record) hold vault locations: written
// owner-only, temp in the same dir then rename so a crash mid-write cannot
// truncate them. The mode only applies on create and the umask masks it,
// hence the chmod on the temp file that survives the rename
async function writeSidecar(filePath: string, data: string): Promise<void> {
    const { handle, tmpPath } = await openExclusiveTemp(filePath, 0o600);
    try {
        try {
            if (process.platform !== 'win32') await handle.chmod(0o600);
            await handle.writeFile(data);
        } finally {
            await handle.close();
        }
        await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw error;
    }
}

export async function saveLastDatabasePath(dbPath: string): Promise<boolean> {
    try {
        await writeSidecar(LAST_DB_PATH, JSON.stringify({ path: dbPath }));
        return true;
    } catch (error) {
        console.error('Failed to save last database path:', error);
        return false;
    }
}

export async function loadLastDatabasePath(): Promise<string | null> {
    try {
        if (fs.existsSync(LAST_DB_PATH)) {
            const data = await fs.promises.readFile(LAST_DB_PATH, 'utf-8');
            const { path: dbPath } = JSON.parse(data);
            if (fs.existsSync(dbPath)) {
                // The renderer follows up with read-file, stat-file and,
                // once unlocked, save-to-file on it
                grantPath(dbPath, { write: true });
                return dbPath;
            }
        }
        return null;
    } catch (error) {
        console.error('Failed to load last database path:', error);
        return null;
    }
}

// Owner read/write, for a vault this app is creating for the first time
const NEW_VAULT_MODE = 0o600;

// Same value, named for the other thing it protects: files written out of a
// vault (attachments), which are as sensitive as the vault they came from
const OWNER_ONLY_MODE = 0o600;

// The mode the temp file must carry so the rename does not change who can
// read the vault. An existing database keeps exactly the permissions it had;
// a new one starts private. Windows is excluded: chmod there only toggles the
// read-only flag, and the real access control is an ACL the rename leaves to
// the parent directory, as it does for every other application
async function targetMode(filePath: string): Promise<number | null> {
    if (process.platform === 'win32') return null;
    try {
        return (await fs.promises.stat(filePath)).mode & 0o777;
    } catch {
        return NEW_VAULT_MODE;
    }
}

// The file a save actually replaces. A vault kept behind a symlink (a synced
// folder linked into place, say) must be written where the link points:
// renaming over the link itself would swap it for a plain file, and every
// save after that would land there while the real vault sat untouched. A
// link with nothing behind it yet is followed too, so the first save
// creates the target rather than replacing the link
async function resolveWriteTarget(filePath: string): Promise<string> {
    try {
        return await fs.promises.realpath(filePath);
    } catch { /* nothing there, or a link to nothing */ }
    try {
        const target = await fs.promises.readlink(filePath);
        return path.resolve(path.dirname(filePath), target);
    } catch {
        return path.resolve(filePath);
    }
}

// Write to a temp file in the same directory, fsync, then rename over the
// target. A crash mid-write leaves the original database intact
async function atomicWrite(requestedPath: string, data: Buffer): Promise<void> {
    const filePath = await resolveWriteTarget(requestedPath);
    const tmpBase = path.join(path.dirname(filePath), `.${path.basename(filePath)}`);
    const mode = await targetMode(filePath);

    // The temp file is the one that survives the rename, so it is the one
    // whose permissions matter. Created at the umask default it would be
    // 0644 on a typical setup, quietly making a 0600 vault world readable
    // on the next save. The open mode is still masked by the umask, so the
    // exact mode is set with a second call that is not
    const { handle, tmpPath } = await openExclusiveTemp(tmpBase, mode ?? 0o666);
    try {
        try {
            if (mode !== null) await handle.chmod(mode);
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw error;
    }

    // The rename is durable only once the directory entry is on disk; a
    // power cut before that can revert to the previous file. Best effort:
    // Windows cannot open a directory for sync, and a failed directory sync
    // must not fail a save that already landed
    try {
        const dirHandle = await fs.promises.open(path.dirname(filePath), 'r');
        try {
            await dirHandle.sync();
        } finally {
            await dirHandle.close();
        }
    } catch { /* the file itself is written and fsynced */ }
}

export async function statFile(filePath: string): Promise<{ success: boolean, mtimeMs?: number, size?: number, error?: string }> {
    try {
        const stat = await fs.promises.stat(filePath);
        return { success: true, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
        return { success: false, error: 'Failed to stat file' };
    }
}

// A vault that cannot be backed up still has to be saveable, so a failure
// here is logged and the write goes ahead
async function tryBackup(filePath: string, backup: BackupRequest): Promise<void> {
    try {
        await backupBeforeWrite(filePath, backup);
    } catch (error) {
        console.error('Failed to back up the database before saving:', error);
    }
}

export async function saveFile(data: Uint8Array, backup: BackupRequest = DEFAULT_BACKUP_OPTIONS): Promise<{ success: boolean, error?: string, filePath?: string }> {
    const { filePath, canceled } = await dialog.showSaveDialog({
        filters: [
            { name: 'KeePass Database', extensions: ['kdbx'] }
        ],
        defaultPath: 'database.kdbx'
    });

    if (canceled || !filePath) {
        return { success: false, error: 'Save cancelled' };
    }

    try {
        // The dialog already confirmed the overwrite, but an existing file
        // here is still a vault about to be replaced
        await tryBackup(filePath, backup);
        await atomicWrite(filePath, Buffer.from(data));
        await saveLastDatabasePath(filePath);
        // Every later save of this session goes through save-to-file
        grantPath(filePath, { write: true });
        return { success: true, filePath };
    } catch (error) {
        console.error('Failed to save file:', error);
        return { success: false, error: 'Failed to save file' };
    }
}

export async function saveAttachment(name: string, data: Uint8Array): Promise<{ success: boolean, error?: string, filePath?: string }> {
    const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: name
    });

    if (canceled || !filePath) {
        return { success: false, error: 'Save cancelled' };
    }

    try {
        // An attachment out of a vault is as sensitive as the vault: it may be
        // a private key or a recovery kit. At the umask default this would land
        // 0644 and be readable by every user on the machine, so write it owner
        // only. Windows is excluded for the same reason as atomicWrite: chmod
        // there only toggles the read-only flag.
        // The open mode is masked by the umask and ignored entirely when the
        // file already exists, so the mode is also set explicitly, exactly as
        // atomicWrite has to
        const handle = await fs.promises.open(filePath, 'w', OWNER_ONLY_MODE);
        try {
            if (process.platform !== 'win32') await handle.chmod(OWNER_ONLY_MODE);
            await handle.writeFile(Buffer.from(data));
        } finally {
            await handle.close();
        }
        // The generated-key-file flow saves through this dialog and the
        // renderer remembers the path to read at every later unlock, so the
        // grant must outlive the session, like selectKeyFile's
        grantPathPersistent(filePath);
        return { success: true, filePath };
    } catch (error) {
        console.error('Failed to save attachment:', error);
        return { success: false, error: 'Failed to save attachment' };
    }
}

export async function saveToFile(filePath: string, data: Uint8Array, backup: BackupRequest = DEFAULT_BACKUP_OPTIONS): Promise<{ success: boolean, error?: string }> {
    try {
        await tryBackup(filePath, backup);
        await atomicWrite(filePath, Buffer.from(data));
        return { success: true };
    } catch (error) {
        console.error('Failed to save file:', error);
        return { success: false, error: 'Failed to save file' };
    }
}

// A vault dropped onto the unlock screen. The path arrives from the preload's
// webUtils.getPathForFile, never as a renderer-chosen string; the extension
// check keeps the resulting grant (which allows writes) to vault files
export function registerDroppedVault(filePath: string): string | null {
    if (typeof filePath !== 'string' || !/\.kdbx$/i.test(filePath) || !path.isAbsolute(filePath)) {
        return null;
    }
    grantPath(filePath, { write: true });
    return filePath;
}

export async function openFile(targetWindow?: BrowserWindow): Promise<{ success: boolean, error?: string, filePath?: string }> {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'KeePass Database', extensions: ['kdbx'] }]
    });

    if (canceled || filePaths.length === 0) {
        return { success: false, error: 'Open cancelled' };
    }

    try {
        const filePath = filePaths[0];
        await handleFileOpen(filePath, targetWindow);
        return { success: true, filePath };
    } catch (error) {
        console.error('Failed to open file:', error);
        return { success: false, error: 'Failed to open file' };
    }
}

export async function selectKeyFile(): Promise<{ canceled: boolean, filePath?: string }> {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'Key Files', extensions: ['keyx', 'key'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (canceled || filePaths.length === 0) {
        return { canceled: true };
    }

    // Persistent: the renderer remembers key file paths per vault and reads
    // them at the next unlock, sessions after this dialog closed
    grantPathPersistent(filePaths[0]);
    return { canceled: false, filePath: filePaths[0] };
}

export async function readFile(filePath: string): Promise<{ success: boolean, error?: string, data?: Buffer }> {
    try {
        const data = await fs.promises.readFile(filePath);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to read file:', error);
        return { success: false, error: 'Failed to read file' };
    }
}

export async function handleFileOpen(filePath: string, targetWindow?: BrowserWindow): Promise<void> {
    try {
        // Covers every open route that starts in the main process: the open
        // dialog, a file-manager launch, second instances, macOS open-file.
        // All of them open a vault, which save-to-file later overwrites
        grantPath(filePath, { write: true });
        const result = await fs.promises.readFile(filePath);
        const window = targetWindow ?? BrowserWindow.getAllWindows()[0];
        if (!window || window.isDestroyed()) return;

        const fileData = {
            data: result,
            path: filePath
        };

        if (window.webContents.isLoading()) {
            window.webContents.once('did-finish-load', () => {
                window.webContents.send('file-opened', fileData);
            });
        } else {
            window.webContents.send('file-opened', fileData);
        }
    } catch (error) {
        console.error('Failed to open file:', error);
    }
}
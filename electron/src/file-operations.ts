import { app, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { backupBeforeWrite, BackupRequest, DEFAULT_BACKUP_OPTIONS } from './backups';

const LAST_DB_PATH = path.join(app.getPath('userData'), 'last_database.json');

export async function saveLastDatabasePath(dbPath: string): Promise<boolean> {
    try {
        await fs.promises.writeFile(LAST_DB_PATH, JSON.stringify({ path: dbPath }));
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

// Write to a temp file in the same directory, fsync, then rename over the
// target. A crash mid-write leaves the original database intact
async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
    const tmpPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`
    );
    const mode = await targetMode(filePath);

    try {
        // The temp file is the one that survives the rename, so it is the one
        // whose permissions matter. Created at the umask default it would be
        // 0644 on a typical setup, quietly making a 0600 vault world readable
        // on the next save. The open mode is still masked by the umask, so the
        // exact mode is set with a second call that is not
        const handle = await fs.promises.open(tmpPath, 'w', mode ?? 0o666);
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

export async function getFilePath(filePath: string): Promise<string | null> {
    try {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const resolvedPath = path.resolve(process.cwd(), filePath);
        if (fs.existsSync(resolvedPath)) {
            return resolvedPath;
        }

        return null;
    } catch (error) {
        console.error('Error resolving file path:', error);
        return null;
    }
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
import { app, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

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

export async function saveFile(data: Uint8Array): Promise<{ success: boolean, error?: string, filePath?: string }> {
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
        await fs.promises.writeFile(filePath, Buffer.from(data));
        await saveLastDatabasePath(filePath);
        return { success: true, filePath };
    } catch (error) {
        console.error('Failed to save file:', error);
        return { success: false, error: 'Failed to save file' };
    }
}

export async function saveToFile(filePath: string, data: Uint8Array): Promise<{ success: boolean, error?: string }> {
    try {
        await fs.promises.writeFile(filePath, Buffer.from(data));
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

export async function openFile(): Promise<{ success: boolean, error?: string, filePath?: string }> {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'KeePass Database', extensions: ['kdbx'] }]
    });

    if (canceled || filePaths.length === 0) {
        return { success: false, error: 'Open cancelled' };
    }

    try {
        const filePath = filePaths[0];
        await handleFileOpen(filePath);
        return { success: true, filePath };
    } catch (error) {
        console.error('Failed to open file:', error);
        return { success: false, error: 'Failed to open file' };
    }
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

export async function handleFileOpen(filePath: string): Promise<void> {
    try {
        const result = await fs.promises.readFile(filePath);
        const mainWindow = BrowserWindow.getAllWindows()[0];
        const fileData = {
            data: result,
            path: filePath
        };

        if (mainWindow?.webContents.isLoading()) {
            // This will be handled by the window module
            mainWindow.webContents.send('set-pending-file-open', fileData);
        } else if (mainWindow) {
            mainWindow.webContents.send('file-opened', fileData);
        }
    } catch (error) {
        console.error('Failed to open file:', error);
    }
}
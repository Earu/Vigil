import { ipcMain } from 'electron';
import { hashPassword } from './crypto';
import { clearClipboard, openExternal, getPlatform } from './utils';
import {
    saveFile,
    saveToFile,
    getFilePath,
    openFile,
    readFile,
    loadLastDatabasePath,
    saveLastDatabasePath
} from './file-operations';
import {
    isBiometricsAvailable,
    hasBiometricsEnabled,
    enableBiometrics,
    getBiometricPassword,
    disableBiometrics
} from './biometrics';

export function setupIpcHandlers(): void {
    // Crypto handlers
    ipcMain.handle('argon2', async (_, password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
        return await hashPassword(password, salt, memory, iterations, length, parallelism, type, version);
    });

    // File operation handlers
    ipcMain.handle('save-file', async (_, data: Uint8Array) => {
        return await saveFile(data);
    });

    ipcMain.handle('save-to-file', async (_, filePath: string, data: Uint8Array) => {
        return await saveToFile(filePath, data);
    });

    ipcMain.handle('get-file-path', async (_, filePath: string) => {
        return await getFilePath(filePath);
    });

    ipcMain.handle('open-file', async () => {
        return await openFile();
    });

    ipcMain.handle('read-file', async (_, filePath: string) => {
        return await readFile(filePath);
    });

    // Database path handlers
    ipcMain.handle('get-last-database-path', async () => {
        return await loadLastDatabasePath();
    });

    ipcMain.handle('save-last-database-path', async (_, dbPath: string) => {
        return await saveLastDatabasePath(dbPath);
    });

    // Biometric handlers
    ipcMain.handle('is-biometrics-available', async () => {
        return await isBiometricsAvailable();
    });

    ipcMain.handle('has-biometrics-enabled', async (_, dbPath: string) => {
        return await hasBiometricsEnabled(dbPath);
    });

    ipcMain.handle('enable-biometrics', async (_, dbPath: string, password: string) => {
        return await enableBiometrics(dbPath, password);
    });

    ipcMain.handle('get-biometric-password', async (_, dbPath: string) => {
        return await getBiometricPassword(dbPath);
    });

    ipcMain.handle('disable-biometrics', async (_, dbPath: string) => {
        return await disableBiometrics(dbPath);
    });

    // Utility handlers
    ipcMain.handle('clear-clipboard', async () => {
        return await clearClipboard();
    });

    ipcMain.handle('open-external', async (_, url: string) => {
        await openExternal(url);
    });

    ipcMain.handle('get-platform', () => getPlatform());
}
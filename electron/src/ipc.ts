import { ipcMain, Notification, app, BrowserWindow, desktopCapturer, screen } from 'electron';
import { findVaultWindow, registerVault, unregisterWindow, focusWindow, setUnsavedChanges } from './window';
import { hashPassword } from './crypto';
import { openExternal, getPlatform, getAppIconPath } from './utils';
import { clearClipboard, copySecret } from './clipboard';
import {
    saveFile,
    saveToFile,
    saveAttachment,
    getFilePath,
    openFile,
    readFile,
    selectKeyFile,
    statFile,
    loadLastDatabasePath,
    saveLastDatabasePath
} from './file-operations';
import {
    isBiometricsAvailable,
    getBiometricsInfo,
    hasBiometricsEnabled,
    enableBiometrics,
    getBiometricPassword,
    disableBiometrics
} from './biometrics';
import { checkEmailBreaches } from './hibp';
import { isSupported as isContentProtectionSupported, isContentProtectionEnabled, setContentProtectionEnabled } from './content-protection';
import { listHardwareKeys, hardwareKeyChallenge, hardwareKeyPresent } from './hardware-key';
import { BackupRequest, DEFAULT_BACKUP_OPTIONS, getBackupInfo, revealBackups } from './backups';
import path from 'path';

export function setupIpcHandlers(): void {
    // Crypto handlers
    ipcMain.handle('argon2', async (_, password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
        return await hashPassword(password, salt, memory, iterations, length, parallelism, type, version);
    });

    // Hardware key (YubiKey challenge-response) handlers
    ipcMain.handle('hardware-key-present', () => {
        return hardwareKeyPresent();
    });

    ipcMain.handle('hardware-key-list', async () => {
        return await listHardwareKeys();
    });

    ipcMain.handle('hardware-key-challenge', async (event, serial: number | null, slot: number, challenge: ArrayBuffer) => {
        // 'hardware-key-touch' opens the renderer's touch prompt; the paired
        // 'hardware-key-touch-done' closes it however the challenge ends
        let touchSignaled = false;
        try {
            const response = await hardwareKeyChallenge(
                serial,
                slot === 1 ? 1 : 2,
                new Uint8Array(challenge),
                () => {
                    touchSignaled = true;
                    if (!event.sender.isDestroyed()) event.sender.send('hardware-key-touch');
                }
            );
            return { success: true, response };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            if (touchSignaled && !event.sender.isDestroyed()) event.sender.send('hardware-key-touch-done');
        }
    });

    // File operation handlers
    ipcMain.handle('save-file', async (_, data: Uint8Array, backup?: BackupRequest) => {
        return await saveFile(data, backup ?? DEFAULT_BACKUP_OPTIONS);
    });

    ipcMain.handle('save-to-file', async (_, filePath: string, data: Uint8Array, backup?: BackupRequest) => {
        return await saveToFile(filePath, data, backup ?? DEFAULT_BACKUP_OPTIONS);
    });

    // Backups taken before each overwrite; see electron/src/backups.ts
    ipcMain.handle('get-backup-info', async (_, filePath: string) => {
        return await getBackupInfo(filePath);
    });

    ipcMain.handle('reveal-backups', async (_, filePath: string) => {
        return await revealBackups(filePath);
    });

    ipcMain.handle('save-attachment', async (_, name: string, data: Uint8Array) => {
        return await saveAttachment(name, data);
    });

    ipcMain.handle('get-file-path', async (_, filePath: string) => {
        return await getFilePath(filePath);
    });

    ipcMain.handle('open-file', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        return await openFile(senderWindow);
    });

    // Window controls: resolved from the sender so they work with any
    // number of windows
    // Raise the window when a browser-driven dialog needs the user's eyes
    ipcMain.handle('focus-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) focusWindow(win);
    });

    ipcMain.handle('minimize-window', (event) => {
        BrowserWindow.fromWebContents(event.sender)?.minimize();
    });

    ipcMain.handle('maximize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });

    ipcMain.handle('close-window', (event) => {
        BrowserWindow.fromWebContents(event.sender)?.close();
    });

    // Reported by the renderer whenever an entry's edit form gains or loses
    // unsaved changes, so the window's close handler can ask before they go
    ipcMain.handle('set-unsaved-changes', (event, dirty: boolean) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) setUnsavedChanges(win, dirty);
    });

    // One window per vault: renderers report what they have open. If the
    // vault is already open elsewhere the reply says so and that window is
    // focused; the caller is expected to back off
    ipcMain.handle('vault-opened', (event, filePath: string) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow || !filePath) return { duplicate: false };

        const existing = findVaultWindow(filePath);
        if (existing && existing !== senderWindow) {
            focusWindow(existing);
            return { duplicate: true };
        }

        registerVault(filePath, senderWindow);
        return { duplicate: false };
    });

    ipcMain.handle('vault-closed', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow) unregisterWindow(senderWindow);
    });

    ipcMain.handle('read-file', async (_, filePath: string) => {
        return await readFile(filePath);
    });

    ipcMain.handle('select-key-file', async () => {
        return await selectKeyFile();
    });

    ipcMain.handle('stat-file', async (_, filePath: string) => {
        return await statFile(filePath);
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

    ipcMain.handle('get-biometrics-info', async () => {
        return await getBiometricsInfo();
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

    // HIBP handlers
    ipcMain.handle('check-email-breaches', async (_, email: string, apiKey: string) => {
        return await checkEmailBreaches(email, apiKey);
    });

    // Screen capture protection
    ipcMain.handle('get-content-protection', () => ({
        supported: isContentProtectionSupported(),
        enabled: isContentProtectionEnabled()
    }));

    ipcMain.handle('set-content-protection', (_, enabled: boolean) => {
        return setContentProtectionEnabled(enabled);
    });

    // Utility handlers
    // The copy itself runs here so it can carry the macOS pasteboard markers,
    // and so the main process knows which value is the vault's to take back
    ipcMain.handle('copy-secret', async (_, text: string) => {
        return await copySecret(text);
    });

    ipcMain.handle('clear-clipboard', async () => {
        return await clearClipboard();
    });

    ipcMain.handle('open-external', async (_, url: string) => {
        return await openExternal(url);
    });

    ipcMain.handle('get-platform', () => getPlatform());

    // QR screen capture; decoding happens in the renderer
    ipcMain.handle('qr-capture-screens', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const wasVisible = senderWindow?.isVisible() ?? false;
        try {
            // hide the window so it cannot cover the QR code
            if (wasVisible) {
                senderWindow!.hide();
                await new Promise(resolve => setTimeout(resolve, 400));
            }
            const largest = screen.getAllDisplays().reduce(
                (acc, d) => ({
                    width: Math.max(acc.width, Math.round(d.size.width * d.scaleFactor)),
                    height: Math.max(acc.height, Math.round(d.size.height * d.scaleFactor)),
                }),
                { width: 1920, height: 1080 }
            );
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: largest });
            const images = sources
                .filter(source => !source.thumbnail.isEmpty())
                .map(source => source.thumbnail.toPNG().toString('base64'));
            if (images.length === 0) {
                return { success: false, error: 'Screen capture produced no image' };
            }
            return { success: true, images };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Screen capture failed' };
        } finally {
            if (wasVisible) senderWindow?.show();
        }
    });

    // Notification handler
    ipcMain.handle('show-notification', async (_, { title, body }: { title: string, body: string }) => {
        const notification = new Notification({
            title,
            body,
            icon: getAppIconPath(),
            silent: false
        });
        notification.show();
    });
}
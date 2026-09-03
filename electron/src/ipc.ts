import { ipcMain, Notification, app, BrowserWindow, desktopCapturer, screen } from 'electron';
import { findVaultWindow, registerVault, unregisterWindow, focusWindow, setUnsavedChanges } from './window';
import { hashPassword } from './crypto';
import { openExternal, getPlatform, getAppIconPath } from './utils';
import { clearClipboard, copySecret } from './clipboard';
import {
    saveFile,
    saveToFile,
    saveAttachment,
    registerDroppedVault,
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
import { logRendererError, revealLogs } from './logger';
import { isPathGranted } from './path-authority';
import path from 'path';

export function setupIpcHandlers(): void {
    // Renderer failures land in the same file as main-process ones. Fire and
    // forget from the renderer; the size cap keeps a looping error from
    // filling the disk faster than rotation can
    ipcMain.on('renderer-log-error', (_, message: unknown) => {
        if (typeof message !== 'string') return;
        logRendererError(message.slice(0, 8192));
    });

    ipcMain.handle('reveal-logs', async () => {
        return await revealLogs();
    });

    // Crypto handlers. Serialized: the per-call memory cap means nothing if
    // N concurrent invokes each allocate up to it; one at a time bounds the
    // KDF's footprint to a single allocation. The cost of that is that every
    // window's unlock waits behind whatever is running, so a call is dropped
    // from the queue when its window goes away, and a running one is asked
    // to stop. The binding honours the signal for a call still queued on its
    // side; a hash already computing runs to the end, which the work cap in
    // crypto.ts keeps to minutes. The timeout is the backstop for a machine
    // slow enough to make even that unreasonable
    const ARGON2_TIMEOUT_MS = 10 * 60 * 1000;
    let argon2Chain: Promise<unknown> = Promise.resolve();
    ipcMain.handle('argon2', (event, password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
        const abort = new AbortController();
        const onGone = () => abort.abort(new Error('The window that asked for this unlock was closed'));
        event.sender.once('destroyed', onGone);
        const timer = setTimeout(() => abort.abort(new Error('Key derivation took too long and was stopped')), ARGON2_TIMEOUT_MS);

        const run = argon2Chain.then(() => {
            if (abort.signal.aborted) throw abort.signal.reason;
            return hashPassword(password, salt, memory, iterations, length, parallelism, type, version, abort.signal);
        }).finally(() => {
            clearTimeout(timer);
            if (!event.sender.isDestroyed()) event.sender.off('destroyed', onGone);
        });
        argon2Chain = run.catch(() => {});
        return run;
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

    // The write grant, held only by vault paths: a read grant (a key file,
    // an attachment destination) must not let vault bytes overwrite the file
    ipcMain.handle('save-to-file', async (_, filePath: string, data: Uint8Array, backup?: BackupRequest) => {
        if (!isPathGranted(filePath, { write: true })) {
            return { success: false, error: 'Failed to save file' };
        }
        return await saveToFile(filePath, data, backup ?? DEFAULT_BACKUP_OPTIONS);
    });

    // Backups taken before each overwrite; see electron/src/backups.ts.
    // Gated like save-to-file: both derive filesystem locations from the
    // argument, and only an open vault has backups to ask about
    ipcMain.handle('get-backup-info', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { directory: '', count: 0, newest: null, totalBytes: 0 };
        }
        return await getBackupInfo(filePath);
    });

    ipcMain.handle('reveal-backups', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { success: false, error: 'Unknown database path' };
        }
        return await revealBackups(filePath);
    });

    ipcMain.handle('save-attachment', async (_, name: string, data: Uint8Array) => {
        return await saveAttachment(name, data);
    });

    ipcMain.handle('register-dropped-file', async (_, filePath: string) => {
        return registerDroppedVault(filePath);
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

    // read-file and stat-file reach only paths the user pointed the app at:
    // dialogs, file-manager opens, real drops, the last-database record. See
    // path-authority.ts. Without the gate they are arbitrary file read for
    // any renderer bug
    ipcMain.handle('read-file', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { success: false, error: 'Failed to read file' };
        }
        return await readFile(filePath);
    });

    ipcMain.handle('select-key-file', async () => {
        return await selectKeyFile();
    });

    ipcMain.handle('stat-file', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { success: false, error: 'Failed to stat file' };
        }
        return await statFile(filePath);
    });

    // Database path handlers
    ipcMain.handle('get-last-database-path', async () => {
        return await loadLastDatabasePath();
    });

    // Only a path already granted this session may be persisted: the stored
    // path is re-granted on the next launch, so an ungated write here would
    // let the renderer launder any path into a grant across a restart
    ipcMain.handle('save-last-database-path', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) {
            return false;
        }
        return await saveLastDatabasePath(dbPath);
    });

    // Biometric handlers
    ipcMain.handle('is-biometrics-available', async () => {
        return await isBiometricsAvailable();
    });

    ipcMain.handle('get-biometrics-info', async () => {
        return await getBiometricsInfo();
    });

    // Gated like the file channels: get-biometric-password hands out a
    // master password for whatever path it is given (the OS prompt shows
    // only a basename), so the path must be one this session actually opened
    ipcMain.handle('has-biometrics-enabled', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) return { success: false, enabled: false, error: 'Unknown database path' };
        return await hasBiometricsEnabled(dbPath);
    });

    ipcMain.handle('enable-biometrics', async (_, dbPath: string, password: string) => {
        if (!isPathGranted(dbPath)) return { success: false, error: 'Unknown database path' };
        return await enableBiometrics(dbPath, password);
    });

    ipcMain.handle('get-biometric-password', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) return { success: false, error: 'Unknown database path' };
        return await getBiometricPassword(dbPath);
    });

    ipcMain.handle('disable-biometrics', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) return { success: false, error: 'Unknown database path' };
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
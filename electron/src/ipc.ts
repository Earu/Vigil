import { Notification, BrowserWindow, desktopCapturer, screen } from 'electron';
import { handle, on } from './ipc-guard';
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
    getBiometricsConfig,
    setBiometricsConfig,
    hasBiometricsEnabled,
    enableBiometrics,
    getBiometricPassword,
    disableBiometrics
} from './biometrics';
import { checkEmailBreaches, setHibpApiKey, hasHibpApiKey } from './hibp';
import { fetchFavicon } from './favicon';
import { isSupported as isContentProtectionSupported, isContentProtectionEnabled, setContentProtectionEnabled } from './content-protection';
import { listHardwareKeys, hardwareKeyChallenge, hardwareKeyPresent } from './hardware-key';
import { BackupRequest, DEFAULT_BACKUP_OPTIONS, getBackupInfo, revealBackups } from './backups';
import { logRendererError, revealLogs } from './logger';
import { isPathGranted } from './path-authority';

export function setupIpcHandlers(): void {
    // Renderer failures land in the same file as main-process ones. Fire and
    // forget from the renderer; the size cap keeps a looping error from
    // filling the disk faster than rotation can
    on('renderer-log-error', (_, message: unknown) => {
        if (typeof message !== 'string') return;
        logRendererError(message.slice(0, 8192));
    });

    handle('reveal-logs', async () => {
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
    handle('argon2', (event, password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
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
    handle('hardware-key-present', () => {
        return hardwareKeyPresent();
    });

    handle('hardware-key-list', async () => {
        return await listHardwareKeys();
    });

    handle('hardware-key-challenge', async (event, serial: number | null, slot: number, challenge: ArrayBuffer) => {
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
    handle('save-file', async (_, data: Uint8Array, backup?: BackupRequest) => {
        return await saveFile(data, backup ?? DEFAULT_BACKUP_OPTIONS);
    });

    // The write grant, held only by vault paths: a read grant (a key file,
    // an attachment destination) must not let vault bytes overwrite the file
    handle('save-to-file', async (_, filePath: string, data: Uint8Array, backup?: BackupRequest) => {
        if (!isPathGranted(filePath, { write: true })) {
            return { success: false, error: 'Failed to save file' };
        }
        return await saveToFile(filePath, data, backup ?? DEFAULT_BACKUP_OPTIONS);
    });

    // Backups taken before each overwrite; see electron/src/backups.ts.
    // Gated like save-to-file: both derive filesystem locations from the
    // argument, and only an open vault has backups to ask about
    handle('get-backup-info', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { directory: '', count: 0, newest: null, totalBytes: 0 };
        }
        return await getBackupInfo(filePath);
    });

    handle('reveal-backups', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { success: false, error: 'Unknown database path' };
        }
        return await revealBackups(filePath);
    });

    handle('save-attachment', async (_, name: string, data: Uint8Array) => {
        return await saveAttachment(name, data);
    });

    handle('register-dropped-file', async (_, filePath: string) => {
        return registerDroppedVault(filePath);
    });

    handle('open-file', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        return await openFile(senderWindow);
    });

    // Window controls: resolved from the sender so they work with any
    // number of windows
    // Raise the window when a browser-driven dialog needs the user's eyes
    handle('focus-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) focusWindow(win);
    });

    handle('minimize-window', (event) => {
        BrowserWindow.fromWebContents(event.sender)?.minimize();
    });

    handle('maximize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });

    handle('close-window', (event) => {
        BrowserWindow.fromWebContents(event.sender)?.close();
    });

    // Reported by the renderer whenever an entry's edit form gains or loses
    // unsaved changes, so the window's close handler can ask before they go
    handle('set-unsaved-changes', (event, dirty: boolean) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) setUnsavedChanges(win, dirty);
    });

    // One window per vault: renderers report what they have open. If the
    // vault is already open elsewhere the reply says so and that window is
    // focused; the caller is expected to back off
    handle('vault-opened', (event, filePath: string) => {
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

    handle('vault-closed', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow) unregisterWindow(senderWindow);
    });

    // read-file and stat-file reach only paths the user pointed the app at:
    // dialogs, file-manager opens, real drops, the last-database record. See
    // path-authority.ts. Without the gate they are arbitrary file read for
    // any renderer bug
    handle('read-file', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { success: false, error: 'Failed to read file' };
        }
        return await readFile(filePath);
    });

    handle('select-key-file', async () => {
        return await selectKeyFile();
    });

    handle('stat-file', async (_, filePath: string) => {
        if (!isPathGranted(filePath)) {
            return { success: false, error: 'Failed to stat file' };
        }
        return await statFile(filePath);
    });

    // Database path handlers
    handle('get-last-database-path', async () => {
        return await loadLastDatabasePath();
    });

    // Only a write-granted path may be persisted: loadLastDatabasePath
    // re-grants the stored path { write: true }, so accepting a read-only
    // grant here (a key file) would launder it into a write grant on the
    // next get-last-database-path call. Every vault-open route grants
    // write, so legitimate saves always pass
    handle('save-last-database-path', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath, { write: true })) {
            return false;
        }
        return await saveLastDatabasePath(dbPath);
    });

    // Biometric handlers
    handle('is-biometrics-available', async () => {
        return await isBiometricsAvailable();
    });

    handle('get-biometrics-info', async () => {
        return await getBiometricsInfo();
    });

    // Global, not per-vault, so no path gate: whether Windows Hello unlock
    // survives a restart (persistent blob) or lives only for the session
    handle('get-biometrics-config', () => getBiometricsConfig());

    handle('set-biometrics-config', async (_, config: unknown) => {
        const strict = (config as { requirePasswordAfterRestart?: unknown } | null)?.requirePasswordAfterRestart;
        if (typeof strict !== 'boolean') return { success: false, error: 'Invalid config' };
        return await setBiometricsConfig({ requirePasswordAfterRestart: strict });
    });

    // Gated like the file channels: get-biometric-password hands out a
    // master password for whatever path it is given (the OS prompt shows
    // only a basename), so the path must be one this session actually opened
    handle('has-biometrics-enabled', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) return { success: false, enabled: false, error: 'Unknown database path' };
        return await hasBiometricsEnabled(dbPath);
    });

    handle('enable-biometrics', async (_, dbPath: string, password: string) => {
        if (!isPathGranted(dbPath)) return { success: false, error: 'Unknown database path' };
        return await enableBiometrics(dbPath, password);
    });

    handle('get-biometric-password', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) return { success: false, error: 'Unknown database path' };
        return await getBiometricPassword(dbPath);
    });

    handle('disable-biometrics', async (_, dbPath: string) => {
        if (!isPathGranted(dbPath)) return { success: false, error: 'Unknown database path' };
        return await disableBiometrics(dbPath);
    });

    // HIBP handlers. The API key stays in the main process (OS keychain);
    // the renderer sends the address and learns only whether a key is stored
    handle('check-email-breaches', async (_, email: string) => {
        if (typeof email !== 'string') throw new Error('Invalid email');
        return await checkEmailBreaches(email);
    });

    handle('set-hibp-api-key', async (_, key: unknown) => {
        if (key !== null && typeof key !== 'string') return { success: false, error: 'Invalid key' };
        return await setHibpApiKey(key);
    });

    handle('has-hibp-api-key', async () => {
        return await hasHibpApiKey();
    });

    // Favicon download for icon promotion; host validation lives with the fetch
    handle('fetch-favicon', async (_, host: unknown) => {
        return await fetchFavicon(host);
    });

    // Screen capture protection
    handle('get-content-protection', () => ({
        supported: isContentProtectionSupported(),
        enabled: isContentProtectionEnabled()
    }));

    handle('set-content-protection', (_, enabled: boolean) => {
        return setContentProtectionEnabled(enabled);
    });

    // Utility handlers
    // The copy itself runs here so it can carry the macOS pasteboard markers,
    // and so the main process knows which value is the vault's to take back.
    // The clear countdown is armed here too, so it survives the renderer that
    // started it; the duration is clamped in copySecret
    handle('copy-secret', async (_, text: string, clearSeconds?: number) => {
        return await copySecret(text, clearSeconds);
    });

    handle('clear-clipboard', async () => {
        return await clearClipboard();
    });

    handle('open-external', async (_, url: string) => {
        return await openExternal(url);
    });

    handle('get-platform', () => getPlatform());

    // QR screen capture; decoding happens in the renderer. Only a focused,
    // visible window may ask: the legit path is the user clicking the scan
    // button, at which point the window is by definition both. Without the
    // gate this channel hands any renderer full-desktop screenshots, the
    // exact capability the page-level permission handler denies
    handle('qr-capture-screens', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow || !senderWindow.isVisible() || !senderWindow.isFocused()) {
            return { success: false, error: 'Screen capture requires the requesting window to be active' };
        }
        try {
            // hide the window so it cannot cover the QR code
            senderWindow.hide();
            await new Promise(resolve => setTimeout(resolve, 400));
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
            // The window can be closed while hidden mid-capture; show() on a
            // destroyed window throws
            if (!senderWindow.isDestroyed()) senderWindow.show();
        }
    });

    // Notification handler
    handle('show-notification', async (_, { title, body }: { title: string, body: string }) => {
        const notification = new Notification({
            title,
            body,
            icon: getAppIconPath(),
            silent: false
        });
        notification.show();
    });
}
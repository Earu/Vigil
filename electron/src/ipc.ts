import { Notification, BrowserWindow, desktopCapturer, screen, shell } from 'electron';
import { handle, on } from './ipc-guard';
import { findVaultWindow, registerVault, unregisterWindow, focusWindow, setUnsavedChanges } from './window';
import { hashPassword } from './crypto';
import { openExternal, getPlatform, getAppIconPath } from './utils';
import { clearClipboard, copySecret } from './clipboard';
import {
    saveFile,
    saveToFile,
    saveAttachment,
    saveKeyFile,
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
import { listHardwareKeys, hardwareKeyChallenge, hardwareKeyPresent, yubicoDevicePresent } from './hardware-key';
import { readAccounts as readOathAccounts, calculateCode as calculateOathCode, listKeys as listOathKeys, pushAccount as pushOathAccount, oathWorthOffering, PushRequest } from './yubikey-oath';
import { BackupRequest, DEFAULT_BACKUP_OPTIONS, getBackupInfo, revealBackups, purgeBackups } from './backups';
import { logRendererError, revealLogs } from './logger';
import { isPathGranted, grantPath } from './path-authority';
import { scanConflictCopies, nominateConflictCopy, isNominatedConflictCopy } from './conflict-copies';
import { agentSocketPath, isAgentRunning, listIdentities, addKeyForWindow, releaseWindow, removeIdentity, forgetKeyForWindow, loadedFingerprints } from './ssh-agent';
import { parsePrivateKey, publicBlobOf, readPublicInfo, fingerprintOf, SshKeyError } from './ssh-key';
import { consumeRecentGesture } from './gesture';
import { decodeQrFromImage } from './qr-decode';

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

    // YubiKey OATH: read-only, and the secrets behind these codes live on
    // the key alone. Nothing here writes to it
    handle('yubikey-oath-offer', async () => {
        return await oathWorthOffering(yubicoDevicePresent());
    });

    handle('yubikey-oath-keys', async () => {
        return await listOathKeys();
    });

    handle('yubikey-oath-accounts', async (_, serial: number | null, password: string | null) => {
        return await readOathAccounts(serial, password);
    });

    // Separate from the read above because this one has side effects: it
    // burns an HOTP counter and lights the key up for a touch
    handle('yubikey-oath-code', async (_, serial: number | null, id: string, password: string | null) => {
        return await calculateOathCode(serial, id, password);
    });

    // The only write: a copy of a vault secret goes onto the key, and the
    // vault keeps the original because the key can never give it back
    handle('yubikey-oath-push', async (_, serial: number | null, request: PushRequest, secret: string, password: string | null) => {
        return await pushOathAccount(serial, request, secret, password);
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

    // Deletes files, so the write grant that only vault paths hold
    handle('purge-backups', async (_, filePath: string) => {
        if (!isPathGranted(filePath, { write: true })) {
            return { success: false, removed: 0, error: 'Unknown database path' };
        }
        return await purgeBackups(filePath);
    });

    // Conflict copies a sync client left beside the vault (conflict-copies.ts).
    // The renderer asks once when it starts listening for the watcher's
    // events, since copies from before the vault opened raise no event.
    // Gated on the vault path: only an open vault has copies to ask about,
    // and each copy found is read-granted for the renderer to examine
    handle('list-conflict-copies', async (_, vaultPath: string) => {
        if (!isPathGranted(vaultPath)) return [];
        const copies = await scanConflictCopies(vaultPath);
        for (const copy of copies) {
            nominateConflictCopy(copy.copyPath);
            grantPath(copy.copyPath);
        }
        return copies;
    });

    // The one delete the renderer may request, and only for a file the main
    // process itself named as a conflict copy: a read grant alone is not
    // enough, since key files hold one too. To the trash, never unlinked
    handle('trash-conflict-copy', async (_, copyPath: string) => {
        if (!isPathGranted(copyPath) || !isNominatedConflictCopy(copyPath)) {
            return { success: false, error: 'Not a conflict copy of an open vault' };
        }
        try {
            await shell.trashItem(copyPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to move the file to the trash' };
        }
    });

    handle('save-attachment', async (_, name: unknown, data: Uint8Array) => {
        return await saveAttachment(name, data);
    });

    handle('save-key-file', async (_, name: unknown, data: Uint8Array) => {
        return await saveKeyFile(name, data);
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
        if (!senderWindow) return;
        unregisterWindow(senderWindow);
        // The vault's SSH keys leave the agent with it
        releaseWindow(senderWindow.id).catch(() => {});
    });

    // SSH agent: private keys stored as entry attachments, pushed into the
    // agent the user already runs (see ssh-agent.ts). The renderer sends the
    // attachment bytes and the entry password each time; the main process
    // keeps only the public half of what it added, for taking it out again
    const MAX_KEY_BYTES = 1024 * 1024;
    const keyFailure = (error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof SshKeyError ? error.code : 'agent',
    });
    const keyBytes = (data: unknown): Uint8Array => {
        if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new SshKeyError('Not a private key file', 'format');
        if (data.byteLength > MAX_KEY_BYTES) throw new SshKeyError('File too large to be a private key', 'format');
        return data;
    };

    handle('ssh-agent-status', async () => {
        const socketPath = await agentSocketPath();
        const addedByVigil = loadedFingerprints();
        if (!await isAgentRunning()) return { running: false, socketPath, identities: [], addedByVigil };
        try {
            return { running: true, socketPath, identities: await listIdentities(), addedByVigil };
        } catch (error) {
            return { running: true, socketPath, identities: [], addedByVigil, error: error instanceof Error ? error.message : String(error) };
        }
    });

    // What the UI shows for a key attachment: type and fingerprint, and
    // whether the entry password opens it
    handle('ssh-agent-inspect-key', (_, data: unknown, passphrase?: unknown) => {
        try {
            const bytes = keyBytes(data);
            const secret = typeof passphrase === 'string' ? passphrase : '';
            try {
                const key = parsePrivateKey(bytes, secret);
                key.privateParts.fill(0);
                return { success: true as const, type: key.type, fingerprint: key.fingerprint, comment: key.comment, encrypted: key.encrypted };
            } catch (error) {
                if (!(error instanceof SshKeyError) || error.code !== 'passphrase') throw error;
                const info = readPublicInfo(bytes);
                return { success: true as const, ...info, passphraseError: error.message };
            }
        } catch (error) {
            return keyFailure(error);
        }
    });

    handle('ssh-agent-add-key', async (event, data: unknown, passphrase: unknown, options: unknown) => {
        try {
            const bytes = keyBytes(data);
            const opts = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
            const lifetime = Number(opts.lifetimeSeconds);
            const key = parsePrivateKey(bytes, typeof passphrase === 'string' ? passphrase : '');
            try {
                await addKeyForWindow(BrowserWindow.fromWebContents(event.sender), key, {
                    // The key's own comment wins; the entry's is the fallback for keys
                    // without one, as KeePassXC does (username@filename)
                    comment: key.comment || (typeof opts.comment === 'string' ? opts.comment : ''),
                    confirm: opts.confirm === true,
                    lifetimeSeconds: Number.isFinite(lifetime) && lifetime > 0 ? Math.min(Math.floor(lifetime), 0x7fffffff) : undefined,
                }, opts.removeAtClose !== false);
            } finally {
                key.privateParts.fill(0);
            }
            return { success: true as const, fingerprint: key.fingerprint };
        } catch (error) {
            return keyFailure(error);
        }
    });

    handle('ssh-agent-remove-key', async (event, data: unknown, passphrase?: unknown) => {
        try {
            const blob = publicBlobOf(keyBytes(data), typeof passphrase === 'string' ? passphrase : '');
            const removed = await removeIdentity(blob);
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            forgetKeyForWindow(senderWindow?.id ?? null, fingerprintOf(blob));
            return removed ? { success: true as const } : { success: false as const, error: 'The agent does not hold this key', code: 'agent' };
        } catch (error) {
            return keyFailure(error);
        }
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

    // Ctrl+plus/minus/0 from the renderer: a packaged build has no View
    // menu (menu.ts), so zoom is offered here. Half a level is about ten
    // percent; Chromium remembers the level per origin across launches
    handle('zoom', (event, direction: 'in' | 'out' | 'reset') => {
        const contents = event.sender;
        const next = direction === 'reset'
            ? 0
            : contents.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5);
        contents.setZoomLevel(Math.max(-3, Math.min(3, next)));
        return contents.getZoomLevel();
    });

    // QR screen capture; decoding happens in the renderer. Only a focused,
    // visible window may ask: the legit path is the user clicking the scan
    // button, at which point the window is by definition both. Without the
    // gate this channel hands any renderer full-desktop screenshots, the
    // exact capability the page-level permission handler denies
    // A full-desktop screenshot, decoded here and handed over as text only.
    // Two gates, both about the same thing: this only ever follows the user
    // clicking the scan button. The window must be visible and focused, and
    // it must have seen a real click or key press in the last two seconds
    // (gesture.ts), which a renderer cannot fake and focus-window cannot
    // supply. The decode stays in this process so that even the gated path
    // never gives the renderer the desktop image itself (qr-decode.ts)
    handle('qr-capture-screens', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow || !senderWindow.isVisible() || !senderWindow.isFocused()) {
            return { success: false, error: 'Screen capture requires the requesting window to be active' };
        }
        if (!consumeRecentGesture(senderWindow)) {
            return { success: false, error: 'Screen capture must follow a click in the window' };
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
            const captured = sources.map(source => source.thumbnail).filter(thumbnail => !thumbnail.isEmpty());
            if (captured.length === 0) {
                return { success: false, error: 'Screen capture produced no image' };
            }
            for (const thumbnail of captured) {
                const text = decodeQrFromImage(thumbnail);
                if (text) return { success: true, text };
            }
            return { success: false, error: 'No QR code found on screen' };
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
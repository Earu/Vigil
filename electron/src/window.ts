import { BrowserWindow, app, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { handleFileOpen } from './file-operations';
import { applyContentProtection } from './content-protection';
import { isDevBuild } from './utils';
import { APP_INDEX_URL } from './app-protocol';
import { trackGestures } from './gesture';
import { watchVault, unwatchWindow, WatchDeps } from './vault-watcher';
import { nominateConflictCopy, probeVaultFolder, resolveVaultFile } from './conflict-copies';
import { grantPath } from './path-authority';
import { releaseWindow } from './ssh-agent';

let pendingFileOpen: { data: Buffer, path: string } | null = null;

// One window per vault: which window has which vault open
const vaultWindows = new Map<string, BrowserWindow>();

export function normalizeVaultPath(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

export function findVaultWindow(filePath: string): BrowserWindow | undefined {
    const win = vaultWindows.get(normalizeVaultPath(filePath));
    return win && !win.isDestroyed() ? win : undefined;
}

// Notified with the open-vault count after every registry change; browser
// integration uses the 0 <-> n transitions for lock/unlock signals
let vaultWindowsListener: ((count: number) => void) | null = null;

export function onVaultWindowsChanged(listener: (count: number) => void): void {
    vaultWindowsListener = listener;
}

function removeWindow(win: BrowserWindow): void {
    for (const [key, value] of vaultWindows) {
        if (value === win) vaultWindows.delete(key);
    }
    // The file is followed for exactly as long as a vault is open in the
    // window (see vault-watcher.ts); a lock or a close ends that
    unwatchWindow(win);
}

// Changes made to the file by anything else (a sync client delivering
// another machine's edit) are merged into the open vault as they land. A
// conflict copy the sync client drops beside it is nominated for the
// renderer to examine: the read grant lets it open the file, the nomination
// is what later allows trashing it, and nothing else about the file is
// decided here (see conflict-copies.ts)
function watchDeps(win: BrowserWindow, filePath: string): WatchDeps {
    return {
        onConflictCopy: (copyPath, hash) => {
            if (win.isDestroyed()) return;
            nominateConflictCopy(copyPath);
            grantPath(copyPath);
            win.webContents.send('vault-conflict-copy', { path: filePath, copyPath, hash });
        },
    };
}

export function registerVault(filePath: string, win: BrowserWindow): void {
    removeWindow(win);
    vaultWindows.set(normalizeVaultPath(filePath), win);
    watchVault(win, filePath, watchDeps(win, filePath));
    vaultWindowsListener?.(getVaultWindows().length);
}

export type FolderAccessRequest =
    | { granted: true }
    | { granted: false; reason: 'cancelled' | 'other-folder' | 'still-denied' };

// macOS let the vault open because the user picked it, and may still refuse
// the folder around it (conflict-copies.ts probeVaultFolder). The same
// gesture grants the folder: the user picking it in an open dialog, which
// macOS then remembers for the app. Asked for by the renderer once it hears
// the folder cannot be listed; a grant that lands puts the watch back on
// the real directory, in place of the polling it fell back to
export async function requestVaultFolderAccess(win: BrowserWindow, filePath: string): Promise<FolderAccessRequest> {
    const dir = path.dirname(resolveVaultFile(filePath));
    const result = await dialog.showOpenDialog(win, {
        title: 'Allow access to the vault folder',
        message: `Vigil can open ${path.basename(filePath)} but not the folder it is in, so copies a sync client leaves beside it stay out of sight. Select the folder to allow that.`,
        buttonLabel: 'Allow',
        defaultPath: dir,
        properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { granted: false, reason: 'cancelled' };
    if (normalizeVaultPath(result.filePaths[0]) !== dir) return { granted: false, reason: 'other-folder' };
    const access = await probeVaultFolder(filePath);
    if (!access.listable) return { granted: false, reason: 'still-denied' };
    // Only while this window still has the vault open
    if (findVaultWindow(filePath) === win) watchVault(win, filePath, watchDeps(win, filePath));
    return { granted: true };
}

export function unregisterWindow(win: BrowserWindow): void {
    removeWindow(win);
    vaultWindowsListener?.(getVaultWindows().length);
}

export function getVaultWindows(): BrowserWindow[] {
    return [...new Set(vaultWindows.values())].filter(win => !win.isDestroyed());
}

// A window showing the unlock screen (no vault open) that can take a file
export function findIdleWindow(): BrowserWindow | undefined {
    return BrowserWindow.getAllWindows().find(win =>
        !win.isDestroyed() && ![...vaultWindows.values()].includes(win)
    );
}

// Windows whose renderer reports an entry edit form holding unsaved changes.
// Locking already asks before discarding those (see handleLock), but closing
// went straight past it and took the edits with it, whether the close came
// from the title bar button, the macOS traffic light, Cmd+W or Alt+F4
const unsavedChanges = new WeakSet<BrowserWindow>();

export function setUnsavedChanges(win: BrowserWindow, dirty: boolean): void {
    if (dirty) unsavedChanges.add(win);
    else unsavedChanges.delete(win);
}

export function hasUnsavedChanges(win: BrowserWindow): boolean {
    return unsavedChanges.has(win);
}

export function focusWindow(win: BrowserWindow): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

export function createWindow(startupFile?: string) {
    // Linux draws no decorations for frameless windows, so rounded corners
    // are done in the renderer over a transparent window
    const isLinux = process.platform === 'linux';
    const isMac = process.platform === 'darwin';
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        // macOS keeps its native frame with a hidden title bar so the system
        // draws the real traffic lights; other platforms are fully frameless
        // with buttons drawn by the renderer. Position matches the 40px
        // title bar: (40 - 12px button) / 2
        ...(isMac
            ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 14 } }
            : { frame: false }),
        transparent: isLinux,
        // No backgroundColor on Linux: setting one (even fully transparent)
        // makes the surface opaque and defeats transparent: true
        ...(isLinux ? {} : { backgroundColor: '#1a1a1a' }),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            // With spellcheck on, Chromium fetches dictionaries from
            // Google's CDN and macOS runs typed text through the system
            // spellchecker; vault contents stay out of both
            spellcheck: false,
            // Paired with the View submenu being absent from a packaged build
            // (see menu.ts): with this off there is nothing left for a stray
            // openDevTools call to open either. Keyed on isPackaged rather
            // than NODE_ENV because an environment variable must not be able
            // to turn a security control back on
            devTools: !app.isPackaged,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Applied before anything is rendered, so the vault is never briefly
    // capturable while the renderer boots
    applyContentProtection(win);

    // Actions that must follow a real click (screen capture for the QR
    // scanner) check for one through this
    trackGestures(win);

    // Set security-related headers including CSP.
    // Fonts are self-hosted (src/fonts), so no remote font or style host is
    // allowed. A packaged build loads from vigil://app (app-protocol.ts), so
    // 'self' is that origin and nothing else: file: in particular is
    // foreign to it.
    //
    // No remote host appears anywhere in this policy. img-src used to name
    // google.com and gstatic.com for the placeholder favicon the entry list
    // loaded directly, which made an <img> tag in a document holding a
    // decrypted vault into a way out to a third party. Website icons are
    // fetched in the main process now and reach the renderer as bytes
    // (favicon.ts, FaviconService), so the renderer opens no connection of
    // its own and the grant is gone with the tag. connect-src names the two
    // HIBP endpoints the breach check calls and nothing else
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    isDevBuild()
                        ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
                          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
                          "style-src 'self' 'unsafe-inline'; " +
                          "img-src 'self' data: blob:; " +
                          "font-src 'self'; " +
                          "connect-src 'self' ws://localhost:5173 http://localhost:5173 https://api.pwnedpasswords.com https://haveibeenpwned.com; " +
                          "base-uri 'self'; " +
                          "form-action 'none'; " +
                          "frame-ancestors 'none';"
                        : "default-src 'self';" +
                          "script-src 'self';" +
                          "style-src 'self' 'unsafe-inline';" +
                          "img-src 'self' data: blob:;" +
                          "font-src 'self';" +
                          "connect-src 'self' https://api.pwnedpasswords.com https://haveibeenpwned.com;" +
                          "base-uri 'self';" +
                          "form-action 'none';" +
                          "frame-ancestors 'none';"
                ]
            }
        });
    });

    // Prevent navigation and new window creation
    win.webContents.on('will-navigate', (event, navigationUrl) => {
        if (!isDevBuild()) {
            // Before anything that could throw: a URL the parser rejects
            // must not slip past as an unhandled event
            event.preventDefault();
            return;
        }
        if (new URL(navigationUrl).origin !== 'http://localhost:5173') {
            event.preventDefault();
        }
    });

    win.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
    });

    // Add this handler for when the window is ready
    win.webContents.on('did-finish-load', () => {
        if (startupFile) {
            // Vault this window was spawned for; only deliver it once so a
            // renderer reload doesn't re-trigger the unlock screen
            handleFileOpen(startupFile, win);
            startupFile = undefined;
        } else if (pendingFileOpen) {
            win.webContents.send('file-opened', pendingFileOpen);
            pendingFileOpen = null;
        } else if ((global as any).startupFilePath) {
            // Database passed on the command line or via file association
            handleFileOpen((global as any).startupFilePath, win);
            (global as any).startupFilePath = undefined;
        }
    });

    // The dialog is async and 'close' is not, so the first close is cancelled
    // and a fresh one issued once the user has answered
    let closeConfirmed = false;
    win.on('close', (event) => {
        if (closeConfirmed || !unsavedChanges.has(win)) return;
        event.preventDefault();
        dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Discard and close', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Unsaved changes',
            message: 'There are unsaved changes.',
            detail: 'Closing the window now discards them.'
        }).then(({ response }) => {
            if (response !== 0 || win.isDestroyed()) return;
            closeConfirmed = true;
            unsavedChanges.delete(win);
            win.close();
        }).catch(() => { /* the window went away while the dialog was up */ });
    });

    win.on('closed', () => {
        unregisterWindow(win);
    });

    // A renderer that crashes never reports vault-closed, and the window
    // stays open showing nothing, so its vault's keys would sit in the agent
    // until the window is closed. They leave with the vault, as on a lock
    win.webContents.on('render-process-gone', () => {
        unregisterWindow(win);
        releaseWindow(win.id).catch(() => {});
    });

    win.on('maximize', () => {
        win.webContents.send('maximize-change', true);
    });

    win.on('unmaximize', () => {
        win.webContents.send('maximize-change', false);
    });

    // macOS fullscreen (green traffic light) hides the buttons, so the
    // renderer drops the space it reserves for them
    win.on('enter-full-screen', () => {
        win.webContents.send('fullscreen-change', true);
    });

    win.on('leave-full-screen', () => {
        win.webContents.send('fullscreen-change', false);
    });

    if (isDevBuild()) {
        win.loadURL('http://localhost:5173');
        win.webContents.openDevTools();
    } else {
        // Never a file:// document: that origin is shared with every file
        // the user can read, and with grantFileProtocolExtraPrivileges off
        // it has no storage anyway. app-protocol.ts serves dist/ under an
        // origin of its own
        win.loadURL(APP_INDEX_URL);
    }

    return win;
}

export function setPendingFileOpen(data: { data: Buffer, path: string }) {
    pendingFileOpen = data;
}
import { BrowserWindow, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { handleFileOpen } from './file-operations';
import { applyContentProtection } from './content-protection';

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
}

export function registerVault(filePath: string, win: BrowserWindow): void {
    removeWindow(win);
    vaultWindows.set(normalizeVaultPath(filePath), win);
    vaultWindowsListener?.(getVaultWindows().length);
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
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Applied before anything is rendered, so the vault is never briefly
    // capturable while the renderer boots
    applyContentProtection(win);

    // Set security-related headers including CSP.
    // Fonts are self-hosted (src/fonts), so no remote font or style host is
    // allowed. Production names the file: scheme because a packaged build
    // loads from a file:// document, where 'self' does not reliably match
    // in Chromium. The remaining google.com / gstatic.com grant is only
    // for entry favicons, which are off unless the user opts in
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    process.env.NODE_ENV === 'development'
                        ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
                          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
                          "style-src 'self' 'unsafe-inline'; " +
                          "img-src 'self' data: blob: https://www.google.com https://*.gstatic.com; " +
                          "font-src 'self'; " +
                          "connect-src 'self' ws://localhost:5173 http://localhost:5173 https://api.pwnedpasswords.com https://haveibeenpwned.com; " +
                          "base-uri 'self'; " +
                          "form-action 'none'; " +
                          "frame-ancestors 'none';"
                        : "default-src 'self';" +
                          "script-src 'self';" +
                          "style-src 'self' 'unsafe-inline';" +
                          "img-src 'self' data: blob: https://www.google.com https://*.gstatic.com;" +
                          "font-src 'self' file:;" +
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
        const parsedUrl = new URL(navigationUrl);
        if (process.env.NODE_ENV === 'development') {
            if (parsedUrl.origin !== 'http://localhost:5173') {
                event.preventDefault();
            }
        } else {
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

    win.on('closed', () => {
        unregisterWindow(win);
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

    if (process.env.NODE_ENV === 'development') {
        win.loadURL('http://localhost:5173');
        win.webContents.openDevTools();
    } else {
        const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');
        console.log('Loading production file from:', indexPath);
        win.loadFile(indexPath);
    }

    return win;
}

export function setPendingFileOpen(data: { data: Buffer, path: string }) {
    pendingFileOpen = data;
}
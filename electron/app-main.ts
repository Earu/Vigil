import { app, BrowserWindow, powerMonitor, session } from 'electron';
import { refuseDebugSwitches } from './src/launch-guard';
import { registerAppScheme, installAppProtocol } from './src/app-protocol';
import { isSmokeBoot, runSmokeBoot } from './src/smoke-boot';
import { createWindow, findVaultWindow, findIdleWindow, focusWindow } from './src/window';
import { setupIpcHandlers } from './src/ipc';
import { setupAutoUpdater } from './src/updater';
import { setupBrowserIntegration } from './src/browser-integration';
import { applyApplicationMenu } from './src/menu';
import { handleFileOpen } from './src/file-operations';
import { clearOnQuit, getPendingSecret } from './src/clipboard';
import { setupLogging } from './src/logger';
import path from 'path';

declare global {
    namespace NodeJS {
        interface Global {
            startupFilePath: string | undefined;
        }
    }
}

// First, and it does not return when it refuses: a packaged build launched
// with a remote debugging switch must not get as far as taking the
// single-instance lock, let alone a window
refuseDebugSwitches();

// The scheme the packaged renderer loads from; registration has to precede
// app ready
registerAppScheme();

// In dev the app path has no package.json, so Electron would fall back to
// "Electron" and put userData in ~/.config/Electron; pin the name so dev and
// packaged builds share ~/.config/Vigil. setName alone is not enough:
// userData is derived before app code runs and must be re-pointed explicitly
app.setName('Vigil');
app.setPath('userData', path.join(app.getPath('appData'), 'Vigil'));

// After the userData re-point above, so the log file lands under Vigil/
// rather than an Electron default; before everything else, so setup failures
// have somewhere to go
setupLogging();

function triggerLock() {
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            window.webContents.send('trigger-lock');
        }
    }
}

// One window per vault: focus the window that has the file, hand it to a
// window sitting on the unlock screen, or spawn a fresh window for it
function routeFileOpen(filePath: string) {
    const existing = findVaultWindow(filePath);
    if (existing) {
        focusWindow(existing);
        return;
    }

    const idle = findIdleWindow();
    if (idle) {
        handleFileOpen(filePath, idle);
        focusWindow(idle);
        return;
    }

    createWindow(filePath);
}

// Transparent window support (rounded corners). The --ozone-platform-hint=auto
// flag comes from the launch command (package.json script / executableArgs):
// appendSwitch is too late for ozone platform selection.
if (process.platform === 'linux') {
    // Needed for transparent windows on X11
    app.commandLine.appendSwitch('enable-transparent-visuals');
}

// Two instances writing the same vault would fight each other; route any
// second launch (e.g. opening a .kdbx from the file manager) to the first
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

app.on('second-instance', (_event, argv) => {
    const filePath = argv.find(arg => arg.endsWith('.kdbx'));
    if (filePath) {
        routeFileOpen(filePath);
        return;
    }

    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
        focusWindow(mainWindow);
    }
});

// On X11 a transparent window created right at 'ready' can come up with an
// opaque visual; a short delay avoids it
function spawnFirstWindow(): Promise<BrowserWindow> {
    if (process.platform === 'linux' && !process.env.WAYLAND_DISPLAY) {
        return new Promise(resolve => setTimeout(() => resolve(createWindow()), 300));
    }
    return Promise.resolve(createWindow());
}

app.whenReady().then(() => {
    // Chromium's default grants most permission requests. The renderer needs
    // exactly two: clipboard read for the scan-QR-from-clipboard flow and
    // sanitized write for the non-electron clipboard fallback. Everything
    // else (camera, microphone, geolocation, display capture, notifications
    // from the page) is denied outright
    const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(allowedPermissions.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
        return allowedPermissions.has(permission);
    });

    // Before the first window, so no window is ever briefly reachable from a
    // default menu that still has DevTools on it
    applyApplicationMenu();
    installAppProtocol();
    setupIpcHandlers();
    setupAutoUpdater();
    setupBrowserIntegration();
    spawnFirstWindow().then(win => {
        if (isSmokeBoot()) runSmokeBoot(win);
    });

    ["suspend", "lock-screen", "unlock-screen", "resume"].forEach(evName => {
        powerMonitor.on(evName as any, triggerLock);
    });
});

// A secret copied out of the vault is cleared when its countdown ends, but the
// countdown lives in a renderer that quitting destroys, so the last clear has
// to happen here. before-quit is synchronous, so the quit is held back for the
// one async clear and then re-issued.
//
// Keyed on clipboard ownership rather than a one-shot latch: clearOnQuit
// releases ownership, so the re-issued quit passes straight through, and a
// quit cancelled later (an unsaved-changes prompt) leaves the next quit able
// to clear whatever the vault copied since
app.on('before-quit', (event) => {
    if (getPendingSecret() === null) return;
    event.preventDefault();
    clearOnQuit()
        .catch(error => console.error('Failed to clear the clipboard on quit:', error))
        .finally(() => app.quit());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Double-clicked vaults arrive as plain file paths via the OS file
// association (electron-builder fileAssociations). kdbx is a file extension,
// not a URL scheme: registering it as a protocol handler would let any web
// page deep-link kdbx:// into the argv sniffing below

// Handle file opening on Windows/Linux
if (process.platform !== 'darwin') {
    const filePath = process.argv.find(arg => arg.endsWith('.kdbx'));
    if (filePath) {
        global.startupFilePath = filePath;
    }
}

// Handle file opening on macOS
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
        routeFileOpen(filePath);
    } else {
        global.startupFilePath = filePath;
    }
});
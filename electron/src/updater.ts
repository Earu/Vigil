import { app, ipcMain, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateStatus =
    | { state: 'disabled' }
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'up-to-date' }
    | { state: 'downloading'; version: string }
    | { state: 'downloaded'; version: string }
    | { state: 'error'; message: string };

let status: UpdateStatus = { state: 'disabled' };

function setStatus(next: UpdateStatus) {
    status = next;
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            window.webContents.send('update-status', status);
        }
    }
}

// Auto-updates work on Windows (NSIS) and Linux (AppImage). macOS requires a
// code-signed app for electron-updater to install anything, and the builds
// are unsigned, so the updater stays off there.
function updatesSupported(): boolean {
    if (!app.isPackaged) return false;
    if (process.platform === 'darwin') return false;
    // Only the AppImage distribution is self-updatable on Linux
    if (process.platform === 'linux' && !process.env.APPIMAGE) return false;
    return true;
}

// electron-updater errors embed full HTTP responses; keep the first line
function shortError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.split('\n')[0].slice(0, 200);
}

async function checkForUpdates(): Promise<UpdateStatus> {
    if (!updatesSupported()) return status;
    setStatus({ state: 'checking' });
    try {
        const result = await autoUpdater.checkForUpdates();
        // update-available / update-not-available events adjust the status;
        // when no update was found the event may have already fired
        if (result && status.state === 'checking') {
            setStatus({ state: 'up-to-date' });
        }
    } catch (err) {
        setStatus({ state: 'error', message: shortError(err) });
    }
    return status;
}

export function setupAutoUpdater(): void {
    ipcMain.handle('get-update-status', () => status);
    ipcMain.handle('check-for-updates', () => checkForUpdates());
    ipcMain.handle('install-update', () => {
        if (status.state === 'downloaded') {
            autoUpdater.quitAndInstall();
        }
    });

    if (!updatesSupported()) return;
    status = { state: 'idle' };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', info => setStatus({ state: 'downloading', version: info.version }));
    autoUpdater.on('update-not-available', () => setStatus({ state: 'up-to-date' }));
    autoUpdater.on('update-downloaded', info => setStatus({ state: 'downloaded', version: info.version }));
    autoUpdater.on('error', err => {
        console.error('Auto-update error:', err);
        setStatus({ state: 'error', message: shortError(err) });
    });

    // One check shortly after startup; manual checks are available in Settings
    setTimeout(() => { checkForUpdates(); }, 5000);
}

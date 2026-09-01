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

// Auto-updates work on Windows (NSIS), Linux (AppImage) and macOS (the zip
// that ships alongside the dmg; Squirrel.Mac cannot install from a dmg, which
// is why the release uploads both).
//
// macOS additionally needs the running app to be code signed, which release
// builds are and locally made ones are not. There is no API that answers
// "am I signed", so an unsigned build finds out by being told: Squirrel
// fails the check and electron-updater reports it. That is a fact about the
// build rather than something gone wrong, so it reads as disabled instead of
// as an error the user should act on (see codeSignatureFailure)
export function updatesSupported(): boolean {
    if (!app.isPackaged) return false;
    // Only the AppImage distribution is self-updatable on Linux
    if (process.platform === 'linux' && !process.env.APPIMAGE) return false;
    return true;
}

// Squirrel.Mac's wording for "this app is not signed, so an update cannot be
// verified or staged". Matched loosely: the exact phrasing has moved between
// versions, and every variant of it means the same thing here
export function codeSignatureFailure(message: string): boolean {
    if (process.platform !== 'darwin') return false;
    const text = message.toLowerCase();
    return text.includes('code signature') || text.includes('code signing')
        || text.includes('not signed') || text.includes('signature validation');
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
        const message = shortError(err);
        setStatus(codeSignatureFailure(message)
            ? { state: 'disabled' }
            : { state: 'error', message });
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
        const message = shortError(err);
        setStatus(codeSignatureFailure(message)
            ? { state: 'disabled' }
            : { state: 'error', message });
    });

    // One check shortly after startup; manual checks are available in Settings
    setTimeout(() => { checkForUpdates(); }, 5000);
}

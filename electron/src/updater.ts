import { app, ipcMain, BrowserWindow, net } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';
import { channelFileName, parsePublicKey, releaseAssetUrl, verifyUpdateMetadata } from './update-signature';

export type UpdateStatus =
    | { state: 'disabled' }
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'up-to-date' }
    | { state: 'downloading'; version: string }
    | { state: 'downloaded'; version: string }
    | { state: 'error'; message: string };

// Public half of the key whose private half signs latest*.yml in the release
// workflow (see update-signature.ts). SPKI DER, base64, as printed by
// scripts/generate-update-key.mjs. Left empty, automatic updates stay off:
// an unverifiable update is worse than none
export const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEANV4rPkaScM8w/KuwSQx26xkEj6SaZgswjKRWlbtl18Q=';

// Where the signed metadata lives; must match electron-builder.config.js
const RELEASE_OWNER = 'Earu';
const RELEASE_REPO = 'Vigil';

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

// Whether this build carries a key to verify update metadata with. Separate
// from updatesSupported so a fork without a key reads as "not in this build"
export function updateKeyConfigured(publicKey: string = UPDATE_PUBLIC_KEY): boolean {
    if (!publicKey) return false;
    try {
        parsePublicKey(publicKey);
        return true;
    } catch (err) {
        console.error('Update public key is unusable, automatic updates are off:', err);
        return false;
    }
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

// Small text assets from the release; the yml is a few hundred bytes
const MAX_ASSET_BYTES = 1024 * 1024;

async function fetchReleaseAsset(url: string): Promise<Uint8Array> {
    const response = await net.fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_ASSET_BYTES) {
        throw new Error(`${url} is larger than an update metadata file can be`);
    }
    return bytes;
}

// The update electron-updater found is only a claim until the metadata it
// came from is shown to carry the release key's signature and to name the
// same version and digests. Only then does the download start
async function verifyAndDownload(info: UpdateInfo): Promise<void> {
    // The GitHub provider tags the info with the release it read; the version
    // is the fallback for a provider that does not
    const tag = (info as UpdateInfo & { tag?: string }).tag ?? `v${info.version}`;
    const channelFile = channelFileName(process.platform, process.arch);
    try {
        const [metadata, signature] = await Promise.all([
            fetchReleaseAsset(releaseAssetUrl(RELEASE_OWNER, RELEASE_REPO, tag, channelFile)),
            fetchReleaseAsset(releaseAssetUrl(RELEASE_OWNER, RELEASE_REPO, tag, `${channelFile}.sig`)),
        ]);
        const result = verifyUpdateMetadata(
            metadata,
            Buffer.from(signature).toString('utf8'),
            parsePublicKey(UPDATE_PUBLIC_KEY),
            { version: info.version, files: info.files.map(f => ({ url: f.url, sha512: f.sha512 })) }
        );
        if (!result.ok) {
            throw new Error(`Update ${info.version} refused: ${result.reason}`);
        }
    } catch (err) {
        console.error('Update metadata verification failed:', err);
        setStatus({ state: 'error', message: shortError(err) });
        return;
    }

    setStatus({ state: 'downloading', version: info.version });
    // Failures surface through the updater's own error event
    autoUpdater.downloadUpdate().catch(() => {});
}

async function checkForUpdates(): Promise<UpdateStatus> {
    if (!updatesSupported() || !updateKeyConfigured()) return status;
    setStatus({ state: 'checking' });
    try {
        const result = await autoUpdater.checkForUpdates();
        // An available update is handled by verifyAndDownload from the
        // update-available event; the status here is only for the case
        // where nothing was found and the event has not already said so
        if (result && !result.isUpdateAvailable && status.state === 'checking') {
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

    if (!updatesSupported() || !updateKeyConfigured()) return;
    status = { state: 'idle' };

    // Nothing is downloaded until verifyAndDownload has vouched for it
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', info => { verifyAndDownload(info); });
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

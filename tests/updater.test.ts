import { describe, it, expect, vi, beforeEach } from 'vitest';

// The platform the module reads is process.platform, so each case sets it
// before importing anything that branches on it
const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

const realPlatform = process.platform;

vi.mock('electron', () => ({
    app: { isPackaged: true, getPath: () => '/tmp' },
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('electron-updater', () => ({ autoUpdater: { on: () => {} } }));

const { codeSignatureFailure, updatesSupported } = await import('../electron/src/updater');

beforeEach(() => setPlatform(realPlatform));

describe('macOS auto-updates', () => {
    it('are supported on a packaged mac build', () => {
        setPlatform('darwin');
        expect(updatesSupported()).toBe(true);
    });

    it('read a signing failure as "not available in this build", not an error', () => {
        setPlatform('darwin');
        // Wordings Squirrel.Mac and electron-updater have used for the same thing
        for (const message of [
            'Could not get code signature for running application',
            'Code signing is required for macOS updates',
            'The app is not signed',
            'Signature validation failed',
        ]) {
            expect(codeSignatureFailure(message)).toBe(true);
        }
    });

    it('still reports a real failure as an error', () => {
        setPlatform('darwin');
        for (const message of [
            'net::ERR_INTERNET_DISCONNECTED',
            'HttpError: 404 Not Found',
            'ENOSPC: no space left on device',
        ]) {
            expect(codeSignatureFailure(message)).toBe(false);
        }
    });

    it('never mistakes a signing message for one on other platforms', () => {
        setPlatform('win32');
        expect(codeSignatureFailure('Could not get code signature')).toBe(false);
    });
});

describe('other platforms', () => {
    it('leaves Linux updates to the AppImage build', () => {
        setPlatform('linux');
        delete process.env.APPIMAGE;
        expect(updatesSupported()).toBe(false);
        process.env.APPIMAGE = '/tmp/Vigil.AppImage';
        expect(updatesSupported()).toBe(true);
        delete process.env.APPIMAGE;
    });
});

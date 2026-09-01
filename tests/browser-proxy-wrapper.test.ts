import { describe, it, expect, vi } from 'vitest';

// The native messaging wrapper is what decides whether the runAsNode fuse can
// be off. macOS and Linux reach the proxy through a --browser-proxy flag and
// need no environment variable; Windows cannot, because Electron writes a
// stray CRLF to stdout there before any app code runs and stdout is the
// protocol stream (electron/electron#12578).

vi.mock('electron', () => ({
    app: { getPath: () => '/nonexistent', getAppPath: () => '/repo', isPackaged: false, on: () => {} },
    ipcMain: { on: () => {}, handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../electron/src/window', () => ({
    getVaultWindows: () => [], onVaultWindowsChanged: () => {},
}));

const { wrapperScript } = await import('../electron/src/browser-integration');

describe('the unix wrapper', () => {
    it('carries no environment variable', () => {
        const script = wrapperScript('/Applications/Vigil.app/Contents/MacOS/Vigil');
        expect(script).not.toMatch(/ELECTRON_RUN_AS_NODE/);
        expect(script).not.toMatch(/export /);
    });

    it('asks the binary for its proxy mode by flag', () => {
        expect(wrapperScript('/opt/vigil/vigil')).toContain('--browser-proxy');
    });

    it('runs the binary it was given, and forwards the browser arguments', () => {
        const script = wrapperScript('/tmp/Vigil.AppImage');
        expect(script).toContain('exec "/tmp/Vigil.AppImage" --browser-proxy "$@"');
    });

    it('passes the app directory only when there is one to pass', () => {
        // Packaged: the executable knows its own app
        expect(wrapperScript('/Applications/Vigil.app/Contents/MacOS/Vigil'))
            .not.toMatch(/--browser-proxy.*\S.*--browser-proxy/);
        expect(wrapperScript('/bin/electron')).toBe(
            '#!/bin/sh\nexec "/bin/electron" --browser-proxy "$@"\n');
        // Dev: the bare Electron binary has no app of its own to load
        expect(wrapperScript('/bin/electron', '/repo')).toBe(
            '#!/bin/sh\nexec "/bin/electron" "/repo" --browser-proxy "$@"\n');
    });

    it('starts with a shebang so the browser can exec it', () => {
        expect(wrapperScript('/opt/vigil/vigil').startsWith('#!/bin/sh\n')).toBe(true);
    });
});

// electron-builder's electronFuses block is one setting for every platform, so
// the split lives in an afterPack hook instead. Only the choice of binary is
// tested here; flipping one needs a real packed app
const { executableFor } = await import('../electron/build-fuses.cjs' as string);

describe('the runAsNode fuse', () => {
    it('is turned off for macOS, on the binary inside the bundle', () => {
        expect(executableFor('darwin', '/out', 'Vigil'))
            .toBe('/out/Vigil.app/Contents/MacOS/Vigil');
    });

    it('is turned off for Linux', () => {
        expect(executableFor('linux', '/out', 'Vigil')).toBe('/out/vigil');
    });

    it('is left as packed on Windows, which still needs it', () => {
        expect(executableFor('win32', '/out', 'Vigil')).toBe(null);
    });
});

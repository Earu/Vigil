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

    it('passes the app entry file only when there is one to pass', () => {
        // Packaged: the executable knows its own app
        expect(wrapperScript('/Applications/Vigil.app/Contents/MacOS/Vigil'))
            .not.toMatch(/--browser-proxy.*\S.*--browser-proxy/);
        expect(wrapperScript('/bin/electron')).toBe(
            '#!/bin/sh\nexec "/bin/electron" --browser-proxy "$@"\n');
        // Dev: the bare Electron binary has no app of its own to load. The
        // entry file, never a directory: dist-electron has no package.json,
        // so Electron refuses it and the browser's key exchange fails
        expect(wrapperScript('/bin/electron', '/repo/dist-electron/main.js')).toBe(
            '#!/bin/sh\nexec "/bin/electron" "/repo/dist-electron/main.js" --browser-proxy "$@"\n');
    });

    it('starts with a shebang so the browser can exec it', () => {
        expect(wrapperScript('/opt/vigil/vigil').startsWith('#!/bin/sh\n')).toBe(true);
    });
});

// The runAsNode fuse has to differ per platform, which package.json cannot
// express, so it is computed in electron-builder.config.js. An afterPack hook
// cannot do it: electron-builder applies its own electronFuses block after
// afterPack runs and would flip the fuse straight back
const loadConfig = async (argv: string[]) => {
    const original = process.argv;
    process.argv = ['node', 'electron-builder', ...argv];
    vi.resetModules();
    try {
        return (await import('../electron-builder.config.js' as string)).default;
    } finally {
        process.argv = original;
    }
};

describe('the runAsNode fuse', () => {
    it('is on when the build targets Windows, which needs it', async () => {
        expect((await loadConfig(['--win'])).electronFuses.runAsNode).toBe(true);
        expect((await loadConfig(['--windows'])).electronFuses.runAsNode).toBe(true);
    });

    it('is off when the build targets macOS or Linux', async () => {
        expect((await loadConfig(['--mac'])).electronFuses.runAsNode).toBe(false);
        expect((await loadConfig(['--linux'])).electronFuses.runAsNode).toBe(false);
    });

    // electron-builder's own short forms. An unrecognised one reads as "no
    // platform named" and falls through to the host, which on a Linux runner
    // would ship a Windows build with the fuse off and browser integration
    // quietly dead
    it('recognises the single-letter platform flags', async () => {
        expect((await loadConfig(['-w'])).electronFuses.runAsNode).toBe(true);
        expect((await loadConfig(['-m'])).electronFuses.runAsNode).toBe(false);
        expect((await loadConfig(['-l'])).electronFuses.runAsNode).toBe(false);
    });

    // yargs accepts every alias with either dash count and an inline value
    it('recognises inline-value and double-dash alias spellings', async () => {
        expect((await loadConfig(['--win=nsis'])).electronFuses.runAsNode).toBe(true);
        expect((await loadConfig(['--windows=nsis'])).electronFuses.runAsNode).toBe(true);
        expect((await loadConfig(['--w'])).electronFuses.runAsNode).toBe(true);
        expect((await loadConfig(['--m'])).electronFuses.runAsNode).toBe(false);
        expect((await loadConfig(['--l'])).electronFuses.runAsNode).toBe(false);
        expect((await loadConfig(['--mac=dmg'])).electronFuses.runAsNode).toBe(false);
        expect((await loadConfig(['--linux=AppImage'])).electronFuses.runAsNode).toBe(false);
    });

    // Arch and unrelated flags must not read as a platform choice
    it('ignores non-platform flags', async () => {
        const host = process.platform === 'win32';
        expect((await loadConfig(['--x64', '--dir'])).electronFuses.runAsNode).toBe(host);
    });

    it('is off for a mixed build, so the weaker setting never leaks across', async () => {
        expect((await loadConfig(['--mac', '--linux'])).electronFuses.runAsNode).toBe(false);
    });

    it('leaves the other fuses alone', async () => {
        const { electronFuses } = await loadConfig(['--mac']);
        expect(electronFuses.enableNodeOptionsEnvironmentVariable).toBe(false);
        expect(electronFuses.enableNodeCliInspectArguments).toBe(false);
        expect(electronFuses.onlyLoadAppFromAsar).toBe(true);
        expect(electronFuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
    });
});

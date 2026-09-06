import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeNameFor, isPrivateDir, isPrivateTokenFile, getSocketPath, getProxyTokenPath } from '../electron/src/browser-socket';

// The socket and the token beside it are only as private as their
// directory: in a shared one another local user can pre-bind the name and
// plant a token for the proxy to read. So the directory has to actually be
// this user's alone, checked rather than assumed from where it came from
describe.skipIf(process.platform === 'win32')('a private runtime directory', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-socket-'));
    const saved = process.env.XDG_RUNTIME_DIR;
    afterAll(() => {
        if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = saved;
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    const dir = (name: string, mode: number) => {
        const full = path.join(scratch, name);
        fs.mkdirSync(full);
        fs.chmodSync(full, mode);
        return full;
    };

    it('is one this user owns with no group or other bits', () => {
        expect(isPrivateDir(dir('own', 0o700))).toBe(true);
        expect(isPrivateDir(dir('shared', 0o755))).toBe(false);
        expect(isPrivateDir(dir('group', 0o770))).toBe(false);
        expect(isPrivateDir(path.join(scratch, 'missing'))).toBe(false);
        // A file is not a directory to put a socket in
        const file = path.join(scratch, 'file');
        fs.writeFileSync(file, '', { mode: 0o600 });
        expect(isPrivateDir(file)).toBe(false);
    });

    it('is where the socket and token go, and nowhere else', () => {
        process.env.XDG_RUNTIME_DIR = dir('runtime', 0o700);
        expect(getSocketPath()).toBe(path.join(process.env.XDG_RUNTIME_DIR, 'vigil.BrowserServer'));
        expect(getProxyTokenPath()).toBe(path.join(process.env.XDG_RUNTIME_DIR, 'vigil.BrowserToken'));

        // The classic /tmp shape: sticky, world-writable. Refused outright
        process.env.XDG_RUNTIME_DIR = dir('tmp-like', 0o1777);
        expect(getSocketPath()).toBeNull();
        expect(getProxyTokenPath()).toBeNull();
    });

    // macOS: the per-user cache directory, never $TMPDIR, which dirhelper
    // sweeps of anything not accessed for three days while the app runs
    it('on macOS uses the per-user cache directory, and only when it is private', () => {
        const env = {};
        const cache = dir('darwin-cache', 0o700);
        const darwin = (darwinCacheDir: () => string | null) => ({ platform: 'darwin' as const, env, darwinCacheDir });

        expect(getSocketPath(darwin(() => cache))).toBe(path.join(cache, 'vigil.BrowserServer'));
        expect(getProxyTokenPath(darwin(() => cache))).toBe(path.join(cache, 'vigil.BrowserToken'));
        // getconf answers with a trailing slash
        expect(getSocketPath(darwin(() => `${cache}/`))).toBe(path.join(cache, 'vigil.BrowserServer'));

        // A shared directory, or none at all, is refused rather than fallen back from
        expect(getSocketPath(darwin(() => dir('darwin-shared', 0o755)))).toBeNull();
        expect(getSocketPath(darwin(() => null))).toBeNull();

        // XDG_RUNTIME_DIR is honoured ahead of it when a user sets one
        const runtime = dir('darwin-runtime', 0o700);
        expect(getSocketPath({ platform: 'darwin', env: { XDG_RUNTIME_DIR: runtime }, darwinCacheDir: () => cache }))
            .toBe(path.join(runtime, 'vigil.BrowserServer'));
    });

    it('on Linux never looks anywhere but XDG_RUNTIME_DIR', () => {
        expect(getSocketPath({ platform: 'linux', env: {}, darwinCacheDir: () => dir('linux-cache', 0o700) })).toBeNull();
    });

    it('vouches for a token file only when it is a private regular file of this user', () => {
        const check = (name: string, mode: number) => {
            const file = path.join(scratch, name);
            fs.writeFileSync(file, 'token', { mode: 0o600 });
            fs.chmodSync(file, mode);
            const fd = fs.openSync(file, 'r');
            try { return isPrivateTokenFile(fd); } finally { fs.closeSync(fd); }
        };
        expect(check('token-own', 0o600)).toBe(true);
        expect(check('token-readable', 0o644)).toBe(false);
        expect(check('token-group', 0o640)).toBe(false);
        // Checked on the descriptor: a link is followed to whatever it names,
        // and that is what has to pass, so a link to a shared file fails
        fs.symlinkSync(path.join(scratch, 'token-readable'), path.join(scratch, 'token-link'));
        const fd = fs.openSync(path.join(scratch, 'token-link'), 'r');
        try { expect(isPrivateTokenFile(fd)).toBe(false); } finally { fs.closeSync(fd); }
    });
});

describe('windows pipe name', () => {
    it('is scoped to the user, as KeePassXC does', () => {
        expect(pipeNameFor('alice')).toBe('\\\\.\\pipe\\vigil.BrowserServer_alice');
        expect(pipeNameFor('alice')).not.toBe(pipeNameFor('bob'));
    });

    it('stays a valid pipe path for names with spaces or punctuation', () => {
        expect(pipeNameFor('Jean Dupont')).toBe('\\\\.\\pipe\\vigil.BrowserServer_Jean_Dupont');
        expect(pipeNameFor('a\\b/c')).toBe('\\\\.\\pipe\\vigil.BrowserServer_a_b_c');
        expect(pipeNameFor('')).toBe('\\\\.\\pipe\\vigil.BrowserServer_user');
    });
});

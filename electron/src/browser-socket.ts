import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// Where the browser-integration server listens, and the one thing the native
// messaging proxy needs to know about it. It lives here rather than in
// browser-integration.ts because the proxy runs in a process that must not
// import electron: see the comment at the top of electron/main.ts

// Windows named pipes share one namespace across every logged-in user, and
// the first process to create a name owns it. A fixed name meant the second
// user's Vigil could not listen at all, and a hostile one could hold the name
// so the victim's browser connected to it instead. KeePassXC suffixes the
// user name for the same reason (BrowserShared::localServerPath); the
// sanitising keeps a name with spaces or punctuation valid as a pipe path
export function pipeNameFor(username: string): string {
    const safe = username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user';
    return `\\\\.\\pipe\\vigil.BrowserServer_${safe}`;
}

function currentUsername(): string {
    if (process.env.USERNAME) return process.env.USERNAME;
    try {
        return os.userInfo().username;
    } catch {
        return '';
    }
}

// Whether a directory is this user's alone: owned by the current uid with
// no group or other bits. The socket and the token beside it are only as
// private as the directory they sit in: in a shared one, another local user
// can pre-bind the socket name, and plant a token of their own for the
// proxy to read, which is the handshake's whole secret
export function isPrivateDir(dir: string): boolean {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return false;
    try {
        const stat = fs.statSync(dir);
        return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
    } catch {
        return false;
    }
}

// The per-user directory launchd keeps for caches: 0700, and unlike $TMPDIR
// not swept. dirhelper deletes anything in $TMPDIR not accessed for three
// days, running app or not (Apple DTS, developer.apple.com/forums/thread/71382),
// and the token is written once at server start and read only when a browser
// launches the proxy, so after a long enough session it was simply gone. This
// is the location Apple names for files that must not be cleaned that way
function darwinUserCacheDir(): string | null {
    try {
        const dir = execFileSync('getconf', ['DARWIN_USER_CACHE_DIR'], {
            encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return dir || null;
    } catch {
        return null;
    }
}

// Tests reach the macOS branch from Linux through these
export interface RuntimeDirDeps {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    darwinCacheDir?: () => string | null;
}

// null means there is nowhere private to put the socket, and refusing is
// better than listening somewhere shared. Linux without XDG_RUNTIME_DIR used
// to fall back to /tmp, and macOS to os.tmpdir(): the former is shared and
// the latter is swept (see darwinUserCacheDir), so neither is used at all
// now. Whatever the directory came from, it has to actually be private,
// checked rather than assumed
export function getSocketPath(deps: RuntimeDirDeps = {}): string | null {
    const platform = deps.platform ?? process.platform;
    const env = deps.env ?? process.env;
    // Windows named pipes live in their own namespace, not the filesystem
    if (platform === 'win32') return pipeNameFor(currentUsername());
    let runtimeDir = env.XDG_RUNTIME_DIR || null;
    if (!runtimeDir && platform === 'darwin') runtimeDir = (deps.darwinCacheDir ?? darwinUserCacheDir)();
    if (!runtimeDir || !isPrivateDir(runtimeDir)) return null;
    return path.join(runtimeDir, 'vigil.BrowserServer');
}

// Whether the token file is one this user wrote and nobody else can read:
// owner-only mode, owned by the current uid, and a regular file rather than
// a link somewhere else. The proxy checks the open descriptor, so what it
// then reads is the file it checked. Windows leaves this to the profile
// ACL and always passes
export function isPrivateTokenFile(fd: number): boolean {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
    try {
        const stat = fs.fstatSync(fd);
        return stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
    } catch {
        return false;
    }
}

// The proxy authenticates the server before forwarding a byte: pipe and
// socket names are first-come-first-served, so whoever holds the name gets
// the browser's connection, and the extension's association key plus every
// saved password would flow to it. The server proves itself by HMACing the
// proxy's challenge with a token kept in a file only this user can read
// (profile ACL on Windows, 0600 in a 0700 directory elsewhere), which a
// cross-user squatter cannot obtain. Same-user malware can read it, but
// same-user could already replace the proxy via the manifest registration.
export const PROXY_AUTH_ACTION = 'vigil-proxy-auth';

// The handshake runs both ways: the server answers the proxy's challenge,
// then the proxy answers the server's, so a connection from another local
// user (Windows pipes let anyone connect) is dropped before a protocol
// message is read. Each direction HMACs under its own label, so one side's
// answer can never be replayed as the other's
export const SERVER_PROOF_LABEL = 'vigil-server:';
export const CLIENT_PROOF_LABEL = 'vigil-client:';

export function getProxyTokenPath(deps: RuntimeDirDeps = {}): string | null {
    if ((deps.platform ?? process.platform) === 'win32') {
        const localAppData = process.env.LOCALAPPDATA
            || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'Vigil', 'browser-proxy-token');
    }
    const socketPath = getSocketPath(deps);
    if (!socketPath) return null;
    return path.join(path.dirname(socketPath), 'vigil.BrowserToken');
}

// Native messaging caps a message at 1 MB. Shared with the server, which drops
// a client that sends more than this without a newline rather than buffering
// for a length that never arrives
export const MAX_MESSAGE_BYTES = 1024 * 1024;

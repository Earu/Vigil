import os from 'os';
import path from 'path';

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

// null means there is nowhere private to put the socket: on Linux without
// XDG_RUNTIME_DIR the old fallback was world-writable /tmp, where another
// local user can pre-bind the fixed name and impersonate Vigil to the
// browser (the proxy authenticates the server, but a squatted name is still
// a denial of service and /tmp squatting is free). Refusing is better than
// listening there. macOS keeps os.tmpdir(): it is per-user 0700
export function getSocketPath(): string | null {
    // Windows named pipes live in their own namespace, not the filesystem
    if (process.platform === 'win32') return pipeNameFor(currentUsername());
    if (process.platform === 'linux' && !process.env.XDG_RUNTIME_DIR) return null;
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    return path.join(runtimeDir, 'vigil.BrowserServer');
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

export function getProxyTokenPath(): string | null {
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA
            || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'Vigil', 'browser-proxy-token');
    }
    const socketPath = getSocketPath();
    if (!socketPath) return null;
    return path.join(path.dirname(socketPath), 'vigil.BrowserToken');
}

// Native messaging caps a message at 1 MB. Shared with the server, which drops
// a client that sends more than this without a newline rather than buffering
// for a length that never arrives
export const MAX_MESSAGE_BYTES = 1024 * 1024;

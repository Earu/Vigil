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

export function getSocketPath(): string {
    // Windows named pipes live in their own namespace, not the filesystem
    if (process.platform === 'win32') return pipeNameFor(currentUsername());
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    return path.join(runtimeDir, 'vigil.BrowserServer');
}

// Native messaging caps a message at 1 MB. Shared with the server, which drops
// a client that sends more than this without a newline rather than buffering
// for a length that never arrives
export const MAX_MESSAGE_BYTES = 1024 * 1024;

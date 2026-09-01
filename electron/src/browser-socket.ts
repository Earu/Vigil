import os from 'os';
import path from 'path';

// Where the browser-integration server listens, and the one thing the native
// messaging proxy needs to know about it. It lives here rather than in
// browser-integration.ts because the proxy runs in a process that must not
// import electron: see the comment at the top of electron/main.ts
export function getSocketPath(): string {
    // Windows named pipes live in their own namespace, not the filesystem
    if (process.platform === 'win32') return '\\\\.\\pipe\\vigil.BrowserServer';
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    return path.join(runtimeDir, 'vigil.BrowserServer');
}

// Native messaging caps a message at 1 MB. Shared with the server, which drops
// a client that sends more than this without a newline rather than buffering
// for a length that never arrives
export const MAX_MESSAGE_BYTES = 1024 * 1024;

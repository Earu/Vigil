import net from 'net';
import { getSocketPath, MAX_MESSAGE_BYTES } from './src/browser-socket';

// Native messaging proxy: browser stdio <-> the Vigil browser-integration
// socket. The browser frames each message with a 4-byte little-endian length;
// the socket speaks newline-delimited JSON.
//
// This runs in the Vigil binary itself, reached by --browser-proxy rather than
// by ELECTRON_RUN_AS_NODE, which is what lets the runAsNode fuse be turned off
// on the platforms that use it (see electron-builder.config.js). Nothing here may
// import electron: stdout is the browser's protocol stream and the process must
// not become the app. See the comment at the top of electron/main.ts.
export function run(): void {
    const client = net.connect(getSocketPath());
    let stdinBuffer = Buffer.alloc(0);
    let socketBuffer = '';

    process.stdin.on('data', (chunk: Buffer) => {
        stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
        while (stdinBuffer.length >= 4) {
            const length = stdinBuffer.readUInt32LE(0);
            // Native messaging caps a message at 1 MB; a longer one is a
            // framing error, and honouring it would buffer for a length that
            // never arrives
            if (length > MAX_MESSAGE_BYTES) process.exit(1);
            if (stdinBuffer.length < 4 + length) break;
            const message = stdinBuffer.subarray(4, 4 + length).toString('utf8');
            stdinBuffer = stdinBuffer.subarray(4 + length);
            client.write(message + '\n');
        }
    });

    client.on('data', (chunk: Buffer) => {
        socketBuffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = socketBuffer.indexOf('\n')) !== -1) {
            const line = socketBuffer.slice(0, newline);
            socketBuffer = socketBuffer.slice(newline + 1);
            if (!line.trim()) continue;
            const payload = Buffer.from(line, 'utf8');
            const header = Buffer.alloc(4);
            header.writeUInt32LE(payload.length, 0);
            process.stdout.write(Buffer.concat([header, payload]));
        }
    });

    client.on('error', () => process.exit(1));
    client.on('close', () => process.exit(0));
    process.stdin.on('end', () => process.exit(0));
}

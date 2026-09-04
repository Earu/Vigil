import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
import {
    getSocketPath,
    getProxyTokenPath,
    PROXY_AUTH_ACTION,
    SERVER_PROOF_LABEL,
    CLIENT_PROOF_LABEL,
    MAX_MESSAGE_BYTES,
} from './src/browser-socket';

// Native messaging proxy: browser stdio <-> the Vigil browser-integration
// socket. The browser frames each message with a 4-byte little-endian length;
// the socket speaks newline-delimited JSON.
//
// Pipe and socket names are first-come-first-served, so the name proves
// nothing about who is listening. Before forwarding a byte in either
// direction the proxy challenges the server to HMAC a random value with the
// token Vigil wrote to a file only this user can read; a cross-user squatter
// holding the name cannot answer and the proxy exits instead of handing it
// the extension's traffic. The server then poses its own challenge, answered
// with the same token, so it knows this proxy is the user's. See
// browser-socket.ts for the trust model.
//
// This runs in the Vigil binary itself, reached by --browser-proxy rather than
// by ELECTRON_RUN_AS_NODE, which is what lets the runAsNode fuse be turned off
// on the platforms that use it (see electron-builder.config.js). Nothing here may
// import electron: stdout is the browser's protocol stream and the process must
// not become the app. See the comment at the top of electron/main.ts.
export function run(): void {
    const socketPath = getSocketPath();
    const tokenPath = getProxyTokenPath();
    if (!socketPath || !tokenPath) process.exit(1);

    let token: string;
    try {
        token = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {
        // No token means no running, set-up Vigil to talk to
        process.exit(1);
    }

    const challenge = crypto.randomBytes(32).toString('base64');
    const expected = crypto.createHmac('sha256', token!).update(SERVER_PROOF_LABEL + challenge).digest();
    let authed = false;
    // Messages the browser sent while the server was still unproven
    const heldMessages: string[] = [];
    const authTimer = setTimeout(() => process.exit(1), 5000);

    let stdinBuffer = Buffer.alloc(0);
    let socketBuffer = '';

    const client = net.connect(socketPath!, () => {
        client.write(JSON.stringify({ action: PROXY_AUTH_ACTION, challenge }) + '\n');
    });

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
            if (authed) client.write(message + '\n');
            else heldMessages.push(message);
        }
    });

    client.on('data', (chunk: Buffer) => {
        socketBuffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = socketBuffer.indexOf('\n')) !== -1) {
            const line = socketBuffer.slice(0, newline);
            socketBuffer = socketBuffer.slice(newline + 1);
            if (!line.trim()) continue;
            if (!authed) {
                // Nothing an unproven server says reaches the browser; the
                // only line that matters yet is the handshake answer, and a
                // wrong one ends the conversation
                let parsed: any;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue;
                }
                if (parsed?.action !== PROXY_AUTH_ACTION) continue;
                let answer: Buffer;
                try {
                    answer = Buffer.from(String(parsed.response ?? ''), 'hex');
                } catch {
                    process.exit(1);
                }
                if (answer!.length !== expected.length || !crypto.timingSafeEqual(answer!, expected)) {
                    process.exit(1);
                }
                // Our proof goes out ahead of anything the browser sent: the
                // server reads nothing else until it has it
                if (typeof parsed.challenge !== 'string') process.exit(1);
                client.write(JSON.stringify({
                    action: PROXY_AUTH_ACTION,
                    response: crypto.createHmac('sha256', token!).update(CLIENT_PROOF_LABEL + parsed.challenge).digest('hex'),
                }) + '\n');
                authed = true;
                clearTimeout(authTimer);
                for (const message of heldMessages) client.write(message + '\n');
                heldMessages.length = 0;
                continue;
            }
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

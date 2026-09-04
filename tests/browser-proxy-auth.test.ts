import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// The pipe/socket name is first-come-first-served, so the proxy must verify
// it reached Vigil before forwarding the extension's traffic: it challenges
// the server to HMAC a random value with a token only this user can read. A
// squatter holding the name cannot answer and gets nothing. The server then
// challenges the proxy the same way, so a connection from another local
// account (Windows pipes accept anyone) is dropped before it can speak.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-proxy-auth-'));
const runtimeDir = path.join(tmpRoot, 'runtime');
fs.mkdirSync(runtimeDir, { mode: 0o700 });
process.env.XDG_RUNTIME_DIR = runtimeDir;

vi.mock('electron', () => ({
    app: { getPath: () => path.join(tmpRoot, 'userData'), on: () => {} },
    ipcMain: { on: () => {}, handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../electron/src/window', () => ({
    getVaultWindows: () => [],
    onVaultWindowsChanged: () => {},
}));

const { startServer, stopServer, proxyScript } =
    await import('../electron/src/browser-integration');
const { getSocketPath, getProxyTokenPath, PROXY_AUTH_ACTION, SERVER_PROOF_LABEL, CLIENT_PROOF_LABEL } =
    await import('../electron/src/browser-socket');

const socketPath = getSocketPath()!;
const tokenPath = getProxyTokenPath()!;

// A raw client against the real server: every line it receives, and
// whether the server hung up on it
function rawClient(): Promise<{
    send: (line: object) => void;
    next: () => Promise<any>;
    closed: () => Promise<boolean>;
    destroy: () => void;
}> {
    return new Promise((resolve, reject) => {
        const lines: any[] = [];
        const waiters: Array<(line: any) => void> = [];
        let closed = false;
        const closeWaiters: Array<() => void> = [];
        let buffer = '';
        const client = net.connect(socketPath, () => resolve({
            send: (line) => client.write(JSON.stringify(line) + '\n'),
            next: () => new Promise((res) => {
                if (lines.length > 0) res(lines.shift());
                else waiters.push(res);
            }),
            closed: () => new Promise((res) => {
                if (closed) return res(true);
                closeWaiters.push(() => res(true));
                setTimeout(() => res(false), 1500).unref();
            }),
            destroy: () => client.destroy(),
        }));
        client.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const parsed = JSON.parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                const waiter = waiters.shift();
                if (waiter) waiter(parsed);
                else lines.push(parsed);
            }
        });
        client.on('close', () => {
            closed = true;
            closeWaiters.forEach(fn => fn());
        });
        client.on('error', (err) => { if (!closed) reject(err); });
    });
}

// Run the generated proxy against whatever holds the socket; feed it one
// native-messaging frame and collect stdout frames and the exit code
function runProxy(message: string): Promise<{ code: number | null; stdout: Buffer }> {
    const scriptFile = path.join(tmpRoot, 'proxy.js');
    fs.writeFileSync(scriptFile, proxyScript());
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptFile], { stdio: ['pipe', 'pipe', 'inherit'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.on('exit', (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
        const payload = Buffer.from(message, 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(payload.length, 0);
        child.stdin.write(Buffer.concat([header, payload]));
        // First stdout frame means the round trip worked; end the session
        child.stdout.once('data', () => child.stdin.end());
        setTimeout(() => child.kill(), 8000).unref();
    });
}

afterEach(() => {
    stopServer();
});

beforeEach(() => {
    fs.rmSync(tokenPath, { force: true });
});

describe('proxy-server handshake', () => {
    it('the real server answers the challenge with the token HMAC and poses its own', async () => {
        expect((await startServer()).success).toBe(true);
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        expect((fs.statSync(tokenPath).mode & 0o777).toString(8)).toBe('600');

        const client = await rawClient();
        client.send({ action: PROXY_AUTH_ACTION, challenge: 'test-challenge' });
        const reply = await client.next();
        client.destroy();

        expect(reply.action).toBe(PROXY_AUTH_ACTION);
        expect(reply.response).toBe(
            crypto.createHmac('sha256', token).update(SERVER_PROOF_LABEL + 'test-challenge').digest('hex'));
        expect(typeof reply.challenge).toBe('string');
        expect(reply.challenge.length).toBeGreaterThan(0);
    });

    it('the server drops a client that speaks the protocol before proving itself', async () => {
        expect((await startServer()).success).toBe(true);

        const client = await rawClient();
        client.send({ action: 'change-public-keys', publicKey: 'AA==', nonce: 'AA==', clientID: 'x' });
        expect(await client.closed()).toBe(true);
    });

    it('the server drops a client whose proof is wrong', async () => {
        expect((await startServer()).success).toBe(true);

        const client = await rawClient();
        client.send({ action: PROXY_AUTH_ACTION, challenge: 'c' });
        await client.next();
        client.send({ action: PROXY_AUTH_ACTION, response: '00'.repeat(32) });
        expect(await client.closed()).toBe(true);
    });

    it('the server answers a client that proves it holds the token', async () => {
        expect((await startServer()).success).toBe(true);
        const token = fs.readFileSync(tokenPath, 'utf8').trim();

        const client = await rawClient();
        client.send({ action: PROXY_AUTH_ACTION, challenge: 'c' });
        const { challenge } = await client.next();
        client.send({
            action: PROXY_AUTH_ACTION,
            response: crypto.createHmac('sha256', token).update(CLIENT_PROOF_LABEL + challenge).digest('hex'),
        });
        client.send({ action: 'change-public-keys', publicKey: 'AA==', nonce: 'AA==', clientID: 'x' });
        const reply = await client.next();
        client.destroy();

        expect(reply.action).toBe('change-public-keys');
        expect(reply.success).toBe('true');
    });

    it('the proxy forwards traffic once the real server proves itself', async () => {
        expect((await startServer()).success).toBe(true);

        const { stdout } = await runProxy(JSON.stringify({ action: 'unknown-action' }));

        // A framed response came back, so the handshake passed and the
        // message crossed; its content is the protocol's business
        expect(stdout.length).toBeGreaterThan(4);
        expect(stdout.readUInt32LE(0)).toBe(stdout.length - 4);
    });

    it('the proxy hands nothing to a squatter that cannot answer the challenge', async () => {
        // A name squatter: speaks the framing, answers the handshake with a
        // wrong HMAC, and pushes an unsolicited message hoping to reach the
        // extension
        const received: string[] = [];
        const squatter = net.createServer((socket) => {
            socket.write(JSON.stringify({ action: 'database-unlocked' }) + '\n');
            socket.on('data', (chunk) => {
                for (const line of chunk.toString('utf8').split('\n')) {
                    if (!line.trim()) continue;
                    received.push(line);
                    const parsed = JSON.parse(line);
                    if (parsed.action === PROXY_AUTH_ACTION) {
                        socket.write(JSON.stringify({
                            action: PROXY_AUTH_ACTION,
                            response: '00'.repeat(32),
                        }) + '\n');
                    }
                }
            });
        });
        await new Promise<void>((resolve) => squatter.listen(socketPath, resolve));
        // The proxy still finds a token from an earlier legitimate run
        fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

        try {
            const { code, stdout } = await runProxy(JSON.stringify({ action: 'get-logins', url: 'https://x.test' }));

            expect(code).toBe(1);
            // Nothing reached the browser, and the extension's message never
            // reached the squatter: only the challenge did
            expect(stdout.length).toBe(0);
            expect(received).toHaveLength(1);
            expect(JSON.parse(received[0]).action).toBe(PROXY_AUTH_ACTION);
        } finally {
            await new Promise((resolve) => squatter.close(resolve));
            fs.rmSync(socketPath, { force: true });
        }
    });

    it('the proxy refuses to run with no token on disk', async () => {
        expect((await startServer()).success).toBe(true);
        fs.rmSync(tokenPath, { force: true });

        const { code, stdout } = await runProxy(JSON.stringify({ action: 'unknown-action' }));

        expect(code).toBe(1);
        expect(stdout.length).toBe(0);
    });
});

import { app, ipcMain, BrowserWindow } from 'electron';
import { spawnSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import { getVaultWindows, onVaultWindowsChanged } from './window';
import {
    HOST_NAME,
    ManifestType,
    chromiumManifest,
    firefoxManifest,
    manifestTargets,
    registryTargets,
    selectTargets,
} from './browser-manifests';

// Server side of the KeePassXC-Browser protocol
// (https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md).
// The browser extension talks native messaging to a small proxy process,
// which forwards newline-delimited JSON over this Unix socket. Message
// payloads are encrypted with crypto_box (X25519-XSalsa20-Poly1305) after a
// change-public-keys handshake. Everything that needs vault data is
// forwarded to a renderer window, which owns the decrypted database.

const PROTOCOL_VERSION = '2.7.10';

const ERROR_DATABASE_NOT_OPENED = 1;
const ERROR_CANNOT_DECRYPT = 2;
const ERROR_INCORRECT_ACTION = 11;
const ERROR_ASSOCIATION_FAILED = 8;
const ERROR_NO_LOGINS_FOUND = 15;
const ERROR_DENIED = 17;

const ERROR_MESSAGES: Record<number, string> = {
    [ERROR_DATABASE_NOT_OPENED]: 'Database not opened',
    [ERROR_CANNOT_DECRYPT]: 'Cannot decrypt message',
    [ERROR_INCORRECT_ACTION]: 'Incorrect action',
    [ERROR_ASSOCIATION_FAILED]: 'Association failed',
    [ERROR_NO_LOGINS_FOUND]: 'No logins found',
    [ERROR_DENIED]: 'Action cancelled or denied',
};

export interface Session {
    clientPublicKey: Uint8Array;
    keyPair: nacl.BoxKeyPair;
    // Set once this client proves it holds a key the database knows, by way of
    // associate or test-associate. Actions whose request carries no key of its
    // own are gated on it, the way KeePassXC gates them on m_associated.
    // Scoped to the session, so it dies with the connection
    associated: boolean;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

const incrementNonce = (nonce: Uint8Array): Uint8Array => {
    const next = new Uint8Array(nonce);
    let carry = 1;
    for (let i = 0; i < next.length && carry; i++) {
        const sum = next[i] + carry;
        next[i] = sum & 0xff;
        carry = sum >> 8;
    }
    return next;
};

let server: net.Server | null = null;
const sessions = new Map<string, Session>();
const clients = new Set<net.Socket>();

// Any local process can open this socket, so a client gets bounded room. The
// largest real message is a passkey request, orders of magnitude under this;
// a client that sends a megabyte without a newline is not speaking the
// protocol and is dropped rather than buffered forever
const MAX_MESSAGE_BYTES = 1024 * 1024;
// Firefox and Chrome each hold one connection per browser; a handful of
// browsers is the honest ceiling, and the rest is somebody looping connect()
const MAX_CLIENTS = 32;

// Unsolicited lock/unlock signals are plain JSON per the protocol, sent to
// every connected proxy so the extension updates its state without polling
function broadcastSignal(action: 'database-locked' | 'database-unlocked'): void {
    for (const socket of clients) {
        if (!socket.destroyed) {
            socket.write(JSON.stringify({ action }) + '\n');
        }
    }
}

let requestCounter = 0;
const pendingRendererRequests = new Map<number, (result: any) => void>();

export function getSocketPath(): string {
    // Windows named pipes live in their own namespace, not the filesystem
    if (process.platform === 'win32') return '\\\\.\\pipe\\vigil.BrowserServer';
    const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    return path.join(runtimeDir, 'vigil.BrowserServer');
}

// Stale socket files only exist on unix; pipes vanish with their server
function removeSocketFile(): void {
    if (process.platform !== 'win32') {
        fs.rmSync(getSocketPath(), { force: true });
    }
}

const configFile = () => path.join(app.getPath('userData'), 'browser-integration.json');

export function isEnabled(): boolean {
    try {
        return JSON.parse(fs.readFileSync(configFile(), 'utf8')).enabled === true;
    } catch {
        return false;
    }
}

function persistEnabled(enabled: boolean): void {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ enabled }));
}

// ---- renderer bridge ----

function askRenderer(win: BrowserWindow, action: string, payload: any, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
        const id = ++requestCounter;
        const timer = setTimeout(() => {
            pendingRendererRequests.delete(id);
            resolve({ errorCode: ERROR_DENIED });
        }, timeoutMs);
        pendingRendererRequests.set(id, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        win.webContents.send('browser-integration-request', { id, action, payload });
    });
}

// Sequentially ask every vault window until one succeeds; get-logins merges
async function askVaults(action: string, payload: any, timeoutMs: number): Promise<any> {
    const windows = getVaultWindows();
    if (windows.length === 0) return { errorCode: ERROR_DATABASE_NOT_OPENED };

    if (action === 'get-logins') {
        const entries: any[] = [];
        let anyAssociated = false;
        for (const win of windows) {
            const result = await askRenderer(win, action, payload, timeoutMs);
            if (!result.errorCode) {
                anyAssociated = true;
                entries.push(...(result.entries ?? []));
            }
        }
        if (!anyAssociated) return { errorCode: ERROR_ASSOCIATION_FAILED };
        if (entries.length === 0) return { errorCode: ERROR_NO_LOGINS_FOUND };
        return { entries };
    }

    let lastError = ERROR_DATABASE_NOT_OPENED;
    let lastInner: any = null;
    for (const win of windows) {
        const result = await askRenderer(win, action, payload, timeoutMs);
        if (!result.errorCode) {
            // Passkey errors are carried inside the response object; a vault
            // with no matching credential reports no-logins-found there, so
            // keep asking the other vaults before settling for that answer
            if (action === 'passkeys-get' && result.response?.errorCode === ERROR_NO_LOGINS_FOUND) {
                lastInner = result;
                continue;
            }
            return result;
        }
        lastError = result.errorCode;
        // associate prompts the user in the first window only
        if (action === 'associate') break;
    }
    if (lastInner) return lastInner;
    return { errorCode: lastError };
}

// ---- protocol ----

// Fallback used when no vault window is open to apply the user's generator
// settings. Rejection sampling keeps the character distribution uniform
function generatePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
    const limit = 256 - (256 % chars.length);
    let password = '';
    while (password.length < 32) {
        for (const byte of crypto.randomBytes(32)) {
            if (byte < limit && password.length < 32) password += chars[byte % chars.length];
        }
    }
    return password;
}

// Exported for tests: this is where the association gate lives
export async function handleDecryptedMessage(action: string, message: any, session: Session): Promise<any> {
    switch (action) {
        case 'get-databasehash':
            return await askVaults('get-databasehash', {}, 5000);
        case 'associate': {
            const result = await askVaults('associate', { key: message.key, idKey: message.idKey }, 120000);
            if (!result.errorCode) session.associated = true;
            return result;
        }
        case 'test-associate': {
            const result = await askVaults('test-associate', { id: message.id, key: message.key }, 5000);
            if (!result.errorCode) session.associated = true;
            return result;
        }
        case 'get-logins':
            return await askVaults('get-logins', {
                url: message.url,
                submitUrl: message.submitUrl,
                httpAuth: message.httpAuth,
                keys: message.keys ?? [],
            }, 10000);
        case 'set-login':
            // Carries no key of its own, so the session is what vouches for
            // the caller. The renderer still asks the user to confirm the
            // write; KeePassXC requires both here too
            if (!session.associated) return { errorCode: ERROR_ASSOCIATION_FAILED };
            return await askVaults('set-login', {
                url: message.url,
                submitUrl: message.submitUrl,
                login: message.login,
                password: message.password,
                uuid: message.uuid,
                group: message.group,
                groupUuid: message.groupUuid,
            }, 60000);
        case 'passkeys-register':
            return await askVaults('passkeys-register', {
                publicKey: message.publicKey,
                origin: message.origin,
                relatedOrigins: message.relatedOrigins,
                groupName: message.groupName,
                keys: message.keys ?? [],
            }, 120000);
        case 'passkeys-get':
            return await askVaults('passkeys-get', {
                publicKey: message.publicKey,
                origin: message.origin,
                relatedOrigins: message.relatedOrigins,
                keys: message.keys ?? [],
            }, 120000);
        case 'generate-password': {
            // The renderer generates with the user's saved generator
            // settings; fall back to a local default when no vault is open
            const result = await askVaults('generate-password', {}, 5000);
            if (!result.errorCode && result.password) return result;
            const password = generatePassword();
            return { password, entries: [{ password }] };
        }
        case 'lock-database':
            for (const win of BrowserWindow.getAllWindows()) {
                win.webContents.send('trigger-lock');
            }
            return {};
        case 'get-totp':
            // A one-time code is vault data, and the request names only a
            // UUID: no key to check per request, so the session is the gate
            // (KeePassXC's handleGetTotp does the same)
            if (!session.associated) return { errorCode: ERROR_ASSOCIATION_FAILED };
            return await askVaults('get-totp', { uuid: message.uuid }, 5000);
        default:
            return { errorCode: ERROR_INCORRECT_ACTION };
    }
}

function errorResponse(action: string, errorCode: number, nonce?: Uint8Array): any {
    return {
        action,
        errorCode: String(errorCode),
        error: ERROR_MESSAGES[errorCode] ?? 'Unknown error',
        nonce: nonce ? b64(incrementNonce(nonce)) : undefined,
    };
}

async function handleEnvelope(envelope: any): Promise<any> {
    const action = envelope.action;
    const clientId = envelope.clientID ?? '';

    if (action === 'change-public-keys') {
        if (!envelope.publicKey || !envelope.nonce) {
            return errorResponse(action, ERROR_CANNOT_DECRYPT);
        }
        const keyPair = nacl.box.keyPair();
        // A fresh handshake starts unassociated, so a client cannot inherit
        // the standing of whoever held this clientID before it
        sessions.set(clientId, { clientPublicKey: unb64(envelope.publicKey), keyPair, associated: false });
        return {
            action,
            version: PROTOCOL_VERSION,
            publicKey: b64(keyPair.publicKey),
            success: 'true',
            nonce: b64(incrementNonce(unb64(envelope.nonce))),
        };
    }

    const session = sessions.get(clientId);
    if (!session || !envelope.message || !envelope.nonce) {
        return errorResponse(action, ERROR_CANNOT_DECRYPT);
    }

    const nonce = unb64(envelope.nonce);
    const opened = nacl.box.open(unb64(envelope.message), nonce, session.clientPublicKey, session.keyPair.secretKey);
    if (!opened) {
        return errorResponse(action, ERROR_CANNOT_DECRYPT);
    }

    let message: any;
    try {
        message = JSON.parse(Buffer.from(opened).toString('utf8'));
    } catch {
        return errorResponse(action, ERROR_CANNOT_DECRYPT);
    }

    const result = await handleDecryptedMessage(message.action ?? action, message, session);
    if (result.errorCode) {
        return errorResponse(action, result.errorCode, nonce);
    }

    const responseNonce = incrementNonce(nonce);
    const inner: any = {
        ...result,
        action: message.action ?? action,
        version: PROTOCOL_VERSION,
        success: 'true',
        nonce: b64(responseNonce),
    };
    if (result.entries && action === 'get-logins') {
        inner.count = result.entries.length;
    }
    const encrypted = nacl.box(
        new Uint8Array(Buffer.from(JSON.stringify(inner), 'utf8')),
        responseNonce,
        session.clientPublicKey,
        session.keyPair.secretKey
    );
    return { action, message: b64(encrypted), nonce: b64(responseNonce) };
}

// ---- socket server ----

export function startServer(): { success: boolean; error?: string } {
    if (server) return { success: true };
    const socketPath = getSocketPath();
    try {
        removeSocketFile();
        server = net.createServer((socket) => {
            if (clients.size >= MAX_CLIENTS) {
                socket.destroy();
                return;
            }
            clients.add(socket);
            socket.on('close', () => clients.delete(socket));
            let buffer = '';
            // One request at a time per connection. Framing below is synchronous,
            // but handleEnvelope is not: without this chain a chunk arriving
            // mid-await would start a second drain and let replies come back in
            // a different order than the requests did
            let pending: Promise<void> = Promise.resolve();
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                if (buffer.length > MAX_MESSAGE_BYTES) {
                    buffer = '';
                    socket.destroy();
                    return;
                }
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (!line.trim()) continue;
                    pending = pending.then(async () => {
                        let envelope: any;
                        try {
                            envelope = JSON.parse(line);
                        } catch {
                            return;
                        }
                        const response = await handleEnvelope(envelope);
                        if (!socket.destroyed) {
                            socket.write(JSON.stringify(response) + '\n');
                        }
                    }).catch(() => { /* one bad request must not stall the rest */ });
                }
            });
            socket.on('error', () => { /* client vanished; nothing to do */ });
        });
        server.listen(socketPath, () => {
            // Lock the socket to the current user. XDG_RUNTIME_DIR is already
            // 0700, but the os.tmpdir() fallback (e.g. /tmp) is world-traversable,
            // so without this another local user on the machine could reach the
            // vault.
            //
            // Windows named pipes are not filesystem objects and keep libuv's
            // default DACL, which measures as:
            //   Everyone                      Read, Synchronize
            //   NT AUTHORITY\ANONYMOUS LOGON  Read, Synchronize
            //   SYSTEM / Administrators       FullControl
            // Read without write, so another user can open the pipe but cannot
            // send a request, and each client gets its own instance so there is
            // nothing of anyone else's to read off it. Untidy rather than a way
            // in, which is why there is no native fix here. The handlers that
            // matter are gated on the session being associated regardless
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(socketPath, 0o600);
                } catch (err) {
                    console.error('Failed to restrict browser socket permissions:', err);
                }
            }
        });
        server.on('error', (err) => {
            console.error('Browser integration server error:', err);
        });
        return { success: true };
    } catch (error) {
        server = null;
        return { success: false, error: error instanceof Error ? error.message : 'Failed to start server' };
    }
}

export function stopServer(): void {
    if (server) {
        server.close();
        server = null;
    }
    for (const socket of clients) socket.destroy();
    clients.clear();
    sessions.clear();
    removeSocketFile();
}

// ---- native messaging manifests ----

function proxyScript(): string {
    return `#!/usr/bin/env node
// Native messaging proxy for Vigil: browser stdio <-> Vigil unix socket
const net = require('net');
const socketPath = ${JSON.stringify(getSocketPath())};
const client = net.connect(socketPath);
let stdinBuffer = Buffer.alloc(0);
let socketBuffer = '';

process.stdin.on('data', (chunk) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
    while (stdinBuffer.length >= 4) {
        const length = stdinBuffer.readUInt32LE(0);
        // Native messaging caps a message at 1 MB; a longer one is a framing
        // error, and honouring it would buffer for a length that never arrives
        if (length > ${MAX_MESSAGE_BYTES}) process.exit(1);
        if (stdinBuffer.length < 4 + length) break;
        const message = stdinBuffer.slice(4, 4 + length).toString('utf8');
        stdinBuffer = stdinBuffer.slice(4 + length);
        client.write(message + '\\n');
    }
});
client.on('data', (chunk) => {
    socketBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = socketBuffer.indexOf('\\n')) !== -1) {
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
`;
}

function wrapperScript(proxyJsPath: string): string {
    // Run the proxy with the Electron binary in Node mode so no system Node
    // install is required; APPIMAGE points at the packaged binary when set.
    // This is why build.electronFuses pins runAsNode on: with it off the
    // binary ignores ELECTRON_RUN_AS_NODE and every wrapper written here
    // launches a second copy of the GUI instead of the proxy. The cost of
    // keeping it on is that the signed binary will run any script handed to
    // it, which on macOS means running inside Vigil's entitlements. Closing
    // that means teaching main.ts a proxy mode reached by a CLI flag, so the
    // wrapper needs no env var at all. Same trap for hardened-runtime
    // entitlements that strip env vars.
    const executable = process.env.APPIMAGE || process.execPath;
    return `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "${executable}" "${proxyJsPath}"
`;
}

// Same idea as the .sh wrapper; @echo off keeps cmd's command echo out of
// the native messaging stdout stream, which must carry only framed JSON
function windowsWrapperScript(proxyJsPath: string): string {
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${proxyJsPath}"\r\n`;
}

export function installManifests(): { success: boolean; written: string[]; error?: string } {
    try {
        const baseDir = path.join(app.getPath('userData'), 'browser');
        fs.mkdirSync(baseDir, { recursive: true });

        const proxyJs = path.join(baseDir, 'vigil-proxy.js');
        fs.writeFileSync(proxyJs, proxyScript());

        if (process.platform === 'win32') {
            const wrapper = path.join(baseDir, 'vigil-proxy.cmd');
            fs.writeFileSync(wrapper, windowsWrapperScript(proxyJs));
            // One manifest file per family, pointed at from the registry
            const manifestFiles: Record<ManifestType, string> = {
                chromium: path.join(baseDir, `${HOST_NAME}.chromium.json`),
                firefox: path.join(baseDir, `${HOST_NAME}.firefox.json`),
            };
            fs.writeFileSync(manifestFiles.chromium, chromiumManifest(wrapper));
            fs.writeFileSync(manifestFiles.firefox, firefoxManifest(wrapper));

            const written: string[] = [];
            let lastError: string | undefined;
            for (const target of registryTargets()) {
                const key = `HKCU\\${target.key}`;
                const result = spawnSync('reg.exe',
                    ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestFiles[target.type], '/f'],
                    { windowsHide: true });
                if (result.status === 0) written.push(key);
                else lastError = result.stderr?.toString().trim() || `reg.exe exited with ${result.status}`;
            }
            return written.length > 0
                ? { success: true, written }
                : { success: false, written, error: lastError ?? 'No registry keys written' };
        }

        const wrapper = path.join(baseDir, 'vigil-proxy.sh');
        fs.writeFileSync(wrapper, wrapperScript(proxyJs), { mode: 0o755 });

        const manifests: Record<ManifestType, string> = {
            chromium: chromiumManifest(wrapper),
            firefox: firefoxManifest(wrapper),
        };

        const targets = manifestTargets(process.platform, os.homedir());
        const written: string[] = [];
        for (const target of selectTargets(targets, fs.existsSync)) {
            fs.mkdirSync(target.dir, { recursive: true });
            const file = path.join(target.dir, `${HOST_NAME}.json`);
            fs.writeFileSync(file, manifests[target.type]);
            written.push(file);
        }
        return { success: true, written };
    } catch (error) {
        return { success: false, written: [], error: error instanceof Error ? error.message : 'Failed to install manifests' };
    }
}

// ---- app wiring ----

export function setupBrowserIntegration(): void {
    // Tell connected extensions when the first vault unlocks or the last one
    // locks, so their icon state follows the app instead of lagging a poll
    let vaultCount = getVaultWindows().length;
    onVaultWindowsChanged((count) => {
        if (count > vaultCount) broadcastSignal('database-unlocked');
        else if (count === 0 && vaultCount > 0) broadcastSignal('database-locked');
        vaultCount = count;
    });

    ipcMain.on('browser-integration-response', (_event, { id, result }: { id: number; result: any }) => {
        const resolve = pendingRendererRequests.get(id);
        if (resolve) {
            pendingRendererRequests.delete(id);
            resolve(result ?? {});
        }
    });

    ipcMain.handle('browser-integration-status', () => ({
        supported: true,
        enabled: isEnabled(),
        running: server !== null,
        socketPath: getSocketPath(),
    }));

    ipcMain.handle('browser-integration-set-enabled', (_event, enabled: boolean) => {
        persistEnabled(enabled);
        if (enabled) {
            const result = startServer();
            // Enabling means the whole thing should work: register the
            // native messaging manifests in the same step
            const manifests = installManifests();
            return { ...result, running: server !== null, written: manifests.written };
        }
        stopServer();
        return { success: true, running: false, written: [] };
    });

    ipcMain.handle('browser-integration-install-manifests', () => {
        return installManifests();
    });

    if (isEnabled()) {
        startServer();
        // Re-write the manifests on every start: the proxy wrapper bakes in
        // the current binary path, which changes between dev and packaged runs
        installManifests();
    }

    app.on('before-quit', () => stopServer());
}

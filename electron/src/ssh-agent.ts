import net from 'net';
import fs from 'fs';
import { execFile } from 'child_process';
import { BrowserWindow } from 'electron';
import { ParsedSshKey, WireReader, fingerprintOf, wireString, wireU32 } from './ssh-key';

// A client of the running ssh-agent, the way KeePassXC's SSH agent
// integration is one: keys stored in the vault are pushed into the agent the
// user already has when a vault opens, and pulled out again when it locks.
// Vigil serves no socket of its own, so ssh, git and everything else keep
// talking to the agent they were configured for, and a confirm constraint is
// answered by ssh-askpass rather than by anything here.
//
// Protocol: draft-miller-ssh-agent. One request per connection, each framed
// as a uint32 length and the message.

export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENT_SUCCESS = 6;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_ADD_IDENTITY = 17;
export const SSH_AGENTC_REMOVE_IDENTITY = 18;
export const SSH_AGENTC_ADD_ID_CONSTRAINED = 25;
export const SSH_AGENT_CONSTRAIN_LIFETIME = 1;
export const SSH_AGENT_CONSTRAIN_CONFIRM = 2;

const CONNECT_TIMEOUT_MS = 1500;
const RESPONSE_TIMEOUT_MS = 5000;
// An identities answer for a busy agent is a few KB; anything approaching
// this is not an agent
const MAX_RESPONSE_BYTES = 1024 * 1024;

const WINDOWS_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

export interface AgentIdentity {
    type: string;
    fingerprint: string;
    comment: string;
}

export interface AddOptions {
    comment: string;
    // ssh-add -c: the agent asks before every use
    confirm?: boolean;
    // ssh-add -t: the agent forgets the key after this many seconds
    lifetimeSeconds?: number;
}

let socketOverride: string | null = null;

// Tests point this at a scratch agent; the app leaves it unset
export function setSocketPathOverride(path: string | null): void {
    socketOverride = path;
}

// On macOS an app launched from Finder or the Dock does not inherit the
// shell's environment, and SSH_AUTH_SOCK is set by launchd, which answers
// launchctl
function launchctlSocket(): Promise<string | null> {
    return new Promise(resolve => {
        execFile('launchctl', ['getenv', 'SSH_AUTH_SOCK'], { timeout: 2000 }, (error, stdout) => {
            const value = error ? '' : stdout.trim();
            resolve(value || null);
        });
    });
}

export async function agentSocketPath(): Promise<string | null> {
    if (socketOverride) return socketOverride;
    if (process.platform === 'win32') return WINDOWS_PIPE;
    const fromEnv = process.env.SSH_AUTH_SOCK;
    if (fromEnv) return fromEnv;
    if (process.platform === 'darwin') return await launchctlSocket();
    return null;
}

export async function isAgentRunning(): Promise<boolean> {
    const path = await agentSocketPath();
    if (!path) return false;
    if (process.platform === 'win32') {
        // A pipe only shows itself by answering a connection
        try {
            await sendMessage(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES]));
            return true;
        } catch {
            return false;
        }
    }
    try {
        return fs.statSync(path).isSocket();
    } catch {
        return false;
    }
}

export async function sendMessage(payload: Buffer): Promise<Buffer> {
    const path = await agentSocketPath();
    if (!path) throw new Error('No SSH agent socket: SSH_AUTH_SOCK is not set');

    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let expected = -1;
        let settled = false;
        const socket = net.connect({ path });

        const finish = (error: Error | null, result?: Buffer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else resolve(result!);
        };
        let timer = setTimeout(() => finish(new Error('SSH agent did not answer')), CONNECT_TIMEOUT_MS);

        socket.on('connect', () => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(new Error('SSH agent did not answer')), RESPONSE_TIMEOUT_MS);
            socket.write(Buffer.concat([wireU32(payload.length), payload]));
        });
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            if (expected < 0 && received >= 4) {
                expected = Buffer.concat(chunks).readUInt32BE(0);
                if (expected > MAX_RESPONSE_BYTES) return finish(new Error('SSH agent protocol error'));
            }
            if (expected >= 0 && received >= 4 + expected) {
                finish(null, Buffer.concat(chunks).subarray(4, 4 + expected));
            }
        });
        socket.on('error', error => finish(new Error(`SSH agent connection failed: ${error.message}`)));
        socket.on('close', () => finish(new Error('SSH agent closed the connection')));
    });
}

export async function listIdentities(): Promise<AgentIdentity[]> {
    const response = await sendMessage(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES]));
    const reader = new WireReader(response);
    if (reader.byte() !== SSH_AGENT_IDENTITIES_ANSWER) throw new Error('SSH agent protocol error');
    const count = reader.u32();
    const identities: AgentIdentity[] = [];
    for (let i = 0; i < count; i++) {
        const blob = Buffer.from(reader.string());
        const comment = reader.text();
        let type = '';
        try {
            type = new WireReader(blob).text();
        } catch { /* an unreadable blob still has a fingerprint */ }
        identities.push({ type, fingerprint: fingerprintOf(blob), comment });
    }
    return identities;
}

export async function addIdentity(key: ParsedSshKey, options: AddOptions): Promise<void> {
    const constrained = !!options.confirm || (options.lifetimeSeconds ?? 0) > 0;
    const parts: Buffer[] = [
        Buffer.from([constrained ? SSH_AGENTC_ADD_ID_CONSTRAINED : SSH_AGENTC_ADD_IDENTITY]),
        wireString(key.type),
        key.privateParts,
        wireString(options.comment),
    ];
    if ((options.lifetimeSeconds ?? 0) > 0) {
        parts.push(Buffer.from([SSH_AGENT_CONSTRAIN_LIFETIME]), wireU32(options.lifetimeSeconds!));
    }
    if (options.confirm) parts.push(Buffer.from([SSH_AGENT_CONSTRAIN_CONFIRM]));

    const request = Buffer.concat(parts);
    let response: Buffer;
    try {
        response = await sendMessage(request);
    } finally {
        request.fill(0);
    }
    if (response.length < 1 || response[0] !== SSH_AGENT_SUCCESS) {
        const reasons = ['The agent refused the key.'];
        if (options.lifetimeSeconds) reasons.push('It may not support a lifetime constraint.');
        if (options.confirm) reasons.push('It may not support a confirmation constraint.');
        throw new Error(reasons.join(' '));
    }
}

export async function removeIdentity(publicBlob: Buffer): Promise<boolean> {
    const response = await sendMessage(Buffer.concat([Buffer.from([SSH_AGENTC_REMOVE_IDENTITY]), wireString(publicBlob)]));
    return response.length > 0 && response[0] === SSH_AGENT_SUCCESS;
}

// Which window put which key in, so a lock or a closed window takes its own
// keys back out and leaves keys another vault also holds

interface Loaded {
    publicBlob: Buffer;
    // Window ids that added this key, each with whether it wants the key gone
    // when its vault closes
    owners: Map<number, boolean>;
}

const loaded = new Map<string, Loaded>();
const closeHooked = new Set<number>();

// The renderer reports a lock through vault-closed; a window that is closed
// or crashes outright reports nothing, so its keys are also tied to the
// window object's own close
function hookClose(win: BrowserWindow): void {
    if (closeHooked.has(win.id)) return;
    closeHooked.add(win.id);
    const id = win.id;
    if (typeof win.once === 'function') {
        win.once('closed', () => {
            closeHooked.delete(id);
            releaseWindow(id).catch(() => { /* logged nowhere: the window is gone */ });
        });
    }
}

export async function addKeyForWindow(win: BrowserWindow | null, key: ParsedSshKey, options: AddOptions, removeAtClose: boolean): Promise<void> {
    await addIdentity(key, options);
    if (!win) return;
    const entry = loaded.get(key.fingerprint) ?? { publicBlob: key.publicBlob, owners: new Map() };
    entry.owners.set(win.id, removeAtClose);
    loaded.set(key.fingerprint, entry);
    hookClose(win);
}

export function forgetKeyForWindow(winId: number | null, fingerprint: string): void {
    const entry = loaded.get(fingerprint);
    if (!entry) return;
    if (winId !== null) entry.owners.delete(winId);
    if (winId === null || entry.owners.size === 0) loaded.delete(fingerprint);
}

// Returns the fingerprints it removed. Errors are swallowed: the agent may
// have gone away, and a lock must not fail over it
export async function releaseWindow(winId: number): Promise<string[]> {
    const removed: string[] = [];
    for (const [fingerprint, entry] of [...loaded]) {
        const wanted = entry.owners.get(winId);
        if (wanted === undefined) continue;
        entry.owners.delete(winId);
        if (entry.owners.size > 0) continue;
        loaded.delete(fingerprint);
        if (!wanted) continue;
        try {
            if (await removeIdentity(entry.publicBlob)) removed.push(fingerprint);
        } catch { /* nothing to take the key out of */ }
    }
    return removed;
}

export function loadedFingerprints(): string[] {
    return [...loaded.keys()];
}

// Test hook
export function resetLoadedForTests(): void {
    loaded.clear();
    closeHooked.clear();
}

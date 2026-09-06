import { describe, it, expect, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { settings, bytes, withinMs } from './fuzz';

// The agent Vigil talks to is whatever SSH_AUTH_SOCK names, which on a shared
// machine is another user's process as easily as the user's own, and on macOS
// is whatever launchctl hands back. tests/ssh-agent.test.ts runs against a
// real ssh-agent, so this is the other half: an agent that answers with
// something no agent would. The keys go in over the same socket, so a reply
// that hangs the main process or drives a loop off its own byte count is a
// finding here rather than a nuisance.
//
// Frames are draft-miller-ssh-agent: a uint32 length and then the message.

vi.mock('electron', () => ({ BrowserWindow: class {} }));

const { setSocketPathOverride, listIdentities, removeIdentity } = await import('../../electron/src/ssh-agent');

const SSH_AGENT_IDENTITIES_ANSWER = 12;
// One identity is two length-prefixed strings, so no payload can hold more
// than an eighth of its own byte count
const BYTES_PER_IDENTITY = 8;
// Under the driver's own 5s response timeout, so a reply that never settles
// fails the property rather than stalling the run
const SETTLE_MS = 2000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-agent-fuzz-'));
const sock = path.join(tmp, 'agent.sock');

// The server answers the first thing it is sent and then hangs up
let reply: (send: (chunk: Buffer) => void, end: () => void) => void = (_, end) => end();

const server = net.createServer(socket => {
    socket.on('error', () => undefined);
    socket.once('data', () => {
        reply(chunk => socket.write(chunk), () => socket.end());
    });
});

await new Promise<void>(resolve => server.listen(sock, resolve));
setSocketPathOverride(sock);

afterAll(async () => {
    setSocketPathOverride(null);
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
});

const u32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0, 0);
    return out;
};

// How an answer arrives: whole, in pieces, with a length that promises more
// than it sends, or cut off partway
type Delivery = 'whole' | 'split' | 'oversize' | 'truncated';

const deliver = (payload: Buffer, delivery: Delivery) => (send: (chunk: Buffer) => void, end: () => void) => {
    if (delivery === 'oversize') {
        // Past the driver's 1 MB ceiling: refused on the length alone
        send(u32(0x7fffffff));
        send(payload);
        return;
    }
    const framed = Buffer.concat([u32(payload.length), payload]);
    if (delivery === 'truncated') {
        send(framed.subarray(0, Math.max(0, framed.length - 1)));
        end();
        return;
    }
    if (delivery === 'split') {
        for (let i = 0; i < framed.length; i += 3) send(framed.subarray(i, i + 3));
        end();
        return;
    }
    send(framed);
    end();
};

const delivery = (): fc.Arbitrary<Delivery> => fc.constantFrom('whole', 'split', 'oversize', 'truncated');

const sshString = (value: Buffer | string): Buffer => {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([u32(body.length), body]);
};

describe('ssh agent replies under fuzz', () => {
    // Nothing below can pass for the right reason unless a well-formed answer
    // still reads as one
    it.skipIf(process.platform === 'win32')('reads an answer a real agent would send', async () => {
        const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 7))]);
        reply = deliver(Buffer.concat([
            Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]), u32(1), sshString(blob), sshString('ryan@vigil'),
        ]), 'whole');
        const [identity] = await listIdentities();
        expect(identity.type).toBe('ssh-ed25519');
        expect(identity.comment).toBe('ryan@vigil');
        expect(identity.fingerprint).toMatch(/^SHA256:/);
    });

    it.skipIf(process.platform === 'win32')('any reply to an identities request settles, and never invents an identity', async () => {
        await fc.assert(fc.asyncProperty(bytes(512), delivery(), async (payload, how) => {
            reply = deliver(Buffer.from(payload), how);
            await withinMs(SETTLE_MS, async () => {
                let identities: Awaited<ReturnType<typeof listIdentities>>;
                try {
                    identities = await listIdentities();
                } catch (error) {
                    expect(error).toBeInstanceOf(Error);
                    return;
                }
                expect(identities.length).toBeLessThanOrEqual(Math.ceil(payload.length / BYTES_PER_IDENTITY));
                for (const identity of identities) {
                    expect(typeof identity.type).toBe('string');
                    expect(typeof identity.fingerprint).toBe('string');
                    expect(typeof identity.comment).toBe('string');
                }
            });
        }), settings());
    });

    it.skipIf(process.platform === 'win32')('a count an answer cannot back never drives the read past its own bytes', async () => {
        await fc.assert(fc.asyncProperty(
            fc.integer({ min: 0, max: 0xffffffff }),
            bytes(64),
            delivery(),
            async (count, tail, how) => {
                // The shape the driver trusts: the right message type, and
                // then a count that says there are four billion identities
                const payload = Buffer.concat([Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]), u32(count), Buffer.from(tail)]);
                reply = deliver(payload, how);
                await withinMs(SETTLE_MS, async () => {
                    try {
                        const identities = await listIdentities();
                        expect(identities.length).toBeLessThanOrEqual(Math.ceil(payload.length / BYTES_PER_IDENTITY));
                    } catch (error) {
                        expect(error).toBeInstanceOf(Error);
                    }
                });
            },
        ), settings());
    });

    it.skipIf(process.platform === 'win32')('a removal is answered with a boolean or an Error, never a hang', async () => {
        await fc.assert(fc.asyncProperty(bytes(128), delivery(), async (payload, how) => {
            reply = deliver(Buffer.from(payload), how);
            await withinMs(SETTLE_MS, async () => {
                try {
                    expect(typeof await removeIdentity(Buffer.from([1, 2, 3]))).toBe('boolean');
                } catch (error) {
                    expect(error).toBeInstanceOf(Error);
                }
            });
        }), settings());
    });
});

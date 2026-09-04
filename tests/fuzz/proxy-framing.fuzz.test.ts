import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { PassThrough } from 'stream';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { settings, bytes } from './fuzz';

// The native messaging proxy reframes bytes between the browser and the
// socket. Any split of a valid stream must reproduce the same messages, and
// any bytes at all must end in a clean exit or nothing, never an exception

const TOKEN = 'f'.repeat(64);
const MAX_MESSAGE_BYTES = 1024 * 1024;

const state = vi.hoisted(() => ({
    client: undefined as unknown as { writes: string[]; emit(event: string, ...args: unknown[]): boolean },
    tokenFile: `${process.env.TMPDIR || '/tmp'}/vigil-proxy-fuzz-token-${process.pid}`,
}));

vi.mock('net', async () => {
    const { EventEmitter } = await import('events');
    class FakeClient extends EventEmitter {
        writes: string[] = [];
        write(data: string): boolean { this.writes.push(data); return true; }
    }
    return {
        default: {
            connect: vi.fn((_path: string, onConnect?: () => void) => {
                state.client = new FakeClient() as unknown as typeof state.client;
                if (onConnect) setImmediate(onConnect);
                return state.client;
            }),
        },
    };
});

vi.mock('../../electron/src/browser-socket', () => ({
    getSocketPath: () => '/fake-socket',
    getProxyTokenPath: () => state.tokenFile,
    PROXY_AUTH_ACTION: 'vigil-proxy-auth',
    SERVER_PROOF_LABEL: 'vigil-server:',
    CLIENT_PROOF_LABEL: 'vigil-client:',
    MAX_MESSAGE_BYTES: 1024 * 1024,
}));

fs.writeFileSync(state.tokenFile, TOKEN);
void path; void os;

const { run } = await import('../../electron/browser-proxy');

class ExitError extends Error {
    constructor(public readonly code: number) { super(`exit ${code}`); }
}

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;

let stdin: PassThrough;
let stdoutChunks: Buffer[];
let client: typeof state.client;

// A fresh proxy instance, authenticated so framing is what is under test
const start = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stdin = new PassThrough();
    stdoutChunks = [];
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', {
        value: { write: (chunk: Buffer) => { stdoutChunks.push(Buffer.from(chunk)); return true; } },
        configurable: true,
    });
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new ExitError(code); }) as never);
    run();
    client = state.client;
    await new Promise(resolve => setImmediate(resolve));
    const { challenge } = JSON.parse(client.writes.shift()!);
    const response = createHmac('sha256', TOKEN).update('vigil-server:' + challenge).digest('hex');
    client.emit('data', Buffer.from(JSON.stringify({ action: 'vigil-proxy-auth', response, challenge: 's' }) + '\n'));
    client.writes.shift();
};

const stop = () => {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    vi.mocked(process.exit).mockRestore();
    vi.useRealTimers();
};

beforeEach(start);
afterEach(stop);

const frame = (payload: Buffer): Buffer => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
};

// Cut a buffer at arbitrary points
const chunked = (whole: Buffer, cuts: number[]): Buffer[] => {
    const points = [...new Set(cuts.map(c => c % (whole.length + 1)))].sort((a, b) => a - b);
    const out: Buffer[] = [];
    let last = 0;
    for (const p of [...points, whole.length]) {
        if (p > last) out.push(whole.subarray(last, p));
        last = p;
    }
    return out;
};

const feed = (chunks: Buffer[]): ExitError | null => {
    try {
        for (const chunk of chunks) stdin.emit('data', chunk);
        return null;
    } catch (error) {
        if (error instanceof ExitError) return error;
        throw error;
    }
};

describe('proxy framing under fuzz', () => {
    it('any chunking of valid frames delivers the same lines in order', () => {
        fc.assert(fc.property(fc.array(bytes(300), { minLength: 1, maxLength: 6 }), fc.array(fc.nat(), { maxLength: 12 }), (payloads, cuts) => {
            client.writes.length = 0;
            const whole = Buffer.concat(payloads.map(p => frame(Buffer.from(p))));
            expect(feed(chunked(whole, cuts))).toBeNull();
            expect(client.writes).toEqual(payloads.map(p => Buffer.from(p).toString('utf8') + '\n'));
        }), settings());
    });

    it('arbitrary bytes from the browser either wait, deliver, or exit 1 on an oversize length', async () => {
        // A fresh proxy per input: a partial frame left in the buffer by
        // one input would change what the next one means
        await fc.assert(fc.asyncProperty(bytes(64), fc.array(fc.nat(), { maxLength: 6 }), async (raw, cuts) => {
            stop();
            await start();
            const whole = Buffer.from(raw);
            const exit = feed(chunked(whole, cuts));
            if (exit) {
                expect(exit.code).toBe(1);
                expect(whole.length).toBeGreaterThanOrEqual(4);
                expect(whole.readUInt32LE(0)).toBeGreaterThan(MAX_MESSAGE_BYTES);
            } else if (whole.length >= 4) {
                expect(whole.readUInt32LE(0)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
            }
        }), settings());
    });

    it('any chunking of socket lines frames each line once with its byte length', () => {
        fc.assert(fc.property(fc.array(fc.string({ minLength: 1 }).filter(s => !s.includes('\n') && s.trim().length > 0), { minLength: 1, maxLength: 6 }), fc.array(fc.nat(), { maxLength: 12 }), (lines, cuts) => {
            stdoutChunks.length = 0;
            const whole = Buffer.from(lines.join('\n') + '\n', 'utf8');
            for (const chunk of chunked(whole, cuts)) client.emit('data', chunk);
            expect(stdoutChunks.map(c => c.subarray(4).toString('utf8'))).toEqual(lines);
            for (const chunk of stdoutChunks) expect(chunk.readUInt32LE(0)).toBe(chunk.length - 4);
        }), settings());
    });

    it('arbitrary bytes from the socket never throw and never produce a frame without a newline', () => {
        fc.assert(fc.property(bytes(200), (raw) => {
            stdoutChunks.length = 0;
            expect(() => client.emit('data', Buffer.from(raw))).not.toThrow();
            const newlines = Buffer.from(raw).toString('utf8').split('\n').length - 1;
            expect(stdoutChunks.length).toBeLessThanOrEqual(newlines);
        }), settings());
    });
});

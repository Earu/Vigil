import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { createHmac } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Transport framing of the native messaging proxy: the browser side frames
// each message with a 4-byte little-endian byte length, the socket side is
// newline-delimited JSON. The proxy translates between the two and must not
// assume chunk boundaries line up with message boundaries on either stream.
// Before any of that it verifies the server: nothing crosses in either
// direction until the server HMACs the proxy's challenge with the token.

const MAX_MESSAGE_BYTES = 1024 * 1024;
const TOKEN = 'f'.repeat(64);

const state = vi.hoisted(() => ({
    client: undefined as unknown as { writes: string[]; emit(event: string, ...args: unknown[]): boolean },
    tokenFile: `${process.env.TMPDIR || '/tmp'}/vigil-proxy-framing-token-${process.pid}`,
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

vi.mock('../electron/src/browser-socket', () => ({
    getSocketPath: () => '/fake-socket',
    getProxyTokenPath: () => state.tokenFile,
    PROXY_AUTH_ACTION: 'vigil-proxy-auth',
    MAX_MESSAGE_BYTES: 1024 * 1024,
}));

fs.writeFileSync(state.tokenFile, TOKEN);

const { run } = await import('../electron/browser-proxy');

class ExitError extends Error {
    constructor(public readonly code: number) { super(`exit ${code}`); }
}

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;

let stdin: PassThrough;
let stdoutChunks: Buffer[];
let client: typeof state.client;

beforeEach(async () => {
    // Fake timeouts so the 5s auth deadline of an instance that never
    // authenticates cannot fire a real process.exit into a later test
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stdin = new PassThrough();
    stdoutChunks = [];
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', {
        value: { write: (chunk: Buffer) => { stdoutChunks.push(Buffer.from(chunk)); return true; } },
        configurable: true,
    });
    // Throwing matches the real exit, which never returns to the loop
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        throw new ExitError(code);
    }) as never);
    run();
    client = state.client;
    // Let the connect callback fire and send the challenge
    await new Promise(resolve => setImmediate(resolve));
});

afterEach(() => {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    vi.mocked(process.exit).mockRestore();
    vi.useRealTimers();
});

// Answer the proxy's challenge the way the real server does, consuming the
// challenge write so framing expectations see only their own traffic
const authenticate = () => {
    const challengeLine = client.writes.shift()!;
    const { challenge } = JSON.parse(challengeLine);
    const response = createHmac('sha256', TOKEN).update(challenge).digest('hex');
    client.emit('data', Buffer.from(JSON.stringify({ action: 'vigil-proxy-auth', response }) + '\n'));
};

const frame = (payload: string): Buffer => {
    const bytes = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([header, bytes]);
};

const expectExit = (fn: () => void, code: number) => {
    let caught: unknown;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(code);
};

describe('handshake', () => {
    it('holds browser frames until the server proves itself, then flushes in order', () => {
        stdin.emit('data', frame('{"first":1}'));
        stdin.emit('data', frame('{"second":2}'));
        // Only the challenge has crossed so far
        expect(client.writes).toHaveLength(1);
        expect(JSON.parse(client.writes[0]).action).toBe('vigil-proxy-auth');

        authenticate();
        expect(client.writes).toEqual(['{"first":1}\n', '{"second":2}\n']);
    });

    it('hands nothing an unproven server says to the browser', () => {
        client.emit('data', Buffer.from('{"action":"database-unlocked"}\n'));
        expect(stdoutChunks).toEqual([]);

        authenticate();
        client.emit('data', Buffer.from('{"ok":true}\n'));
        expect(stdoutChunks).toHaveLength(1);
    });

    it('exits with 1 on a wrong challenge answer', () => {
        client.writes.shift();
        expectExit(() => client.emit('data', Buffer.from(
            JSON.stringify({ action: 'vigil-proxy-auth', response: '00'.repeat(32) }) + '\n')), 1);
        expect(stdoutChunks).toEqual([]);
    });
});

describe('browser to socket', () => {
    beforeEach(authenticate);

    it('forwards one complete frame as one newline-terminated line', () => {
        stdin.emit('data', frame('{"action":"get-logins"}'));
        expect(client.writes).toEqual(['{"action":"get-logins"}\n']);
    });

    it('reassembles a frame split inside the header', () => {
        const whole = frame('{"a":1}');
        stdin.emit('data', whole.subarray(0, 2));
        expect(client.writes).toEqual([]);
        stdin.emit('data', whole.subarray(2));
        expect(client.writes).toEqual(['{"a":1}\n']);
    });

    it('reassembles a frame split inside the payload', () => {
        const whole = frame('{"a":"long enough to split"}');
        stdin.emit('data', whole.subarray(0, 10));
        expect(client.writes).toEqual([]);
        stdin.emit('data', whole.subarray(10));
        expect(client.writes).toEqual(['{"a":"long enough to split"}\n']);
    });

    it('splits two frames arriving in one chunk, in order', () => {
        stdin.emit('data', Buffer.concat([frame('{"first":1}'), frame('{"second":2}')]));
        expect(client.writes).toEqual(['{"first":1}\n', '{"second":2}\n']);
    });

    it('reads the declared length as bytes, not characters', () => {
        const payload = '{"name":"pâsswörd № 1"}';
        expect(Buffer.byteLength(payload)).toBeGreaterThan(payload.length);
        stdin.emit('data', frame(payload));
        expect(client.writes).toEqual([payload + '\n']);
    });

    it('exits with 1 on a length over the native messaging cap, writing nothing', () => {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
        expectExit(() => stdin.emit('data', header), 1);
        expect(client.writes).toEqual([]);
    });
});

describe('socket to browser', () => {
    beforeEach(authenticate);

    it('frames one line with a little-endian byte-length header', () => {
        client.emit('data', Buffer.from('{"ok":true}\n'));
        expect(stdoutChunks).toHaveLength(1);
        expect(stdoutChunks[0].readUInt32LE(0)).toBe(Buffer.byteLength('{"ok":true}'));
        expect(stdoutChunks[0].subarray(4).toString('utf8')).toBe('{"ok":true}');
    });

    it('holds a partial line until the newline arrives', () => {
        client.emit('data', Buffer.from('{"ok":'));
        expect(stdoutChunks).toEqual([]);
        client.emit('data', Buffer.from('true}\n'));
        expect(stdoutChunks).toHaveLength(1);
        expect(stdoutChunks[0].subarray(4).toString('utf8')).toBe('{"ok":true}');
    });

    it('frames each of several lines in one chunk', () => {
        client.emit('data', Buffer.from('{"a":1}\n{"b":2}\n'));
        expect(stdoutChunks.map(chunk => chunk.subarray(4).toString('utf8')))
            .toEqual(['{"a":1}', '{"b":2}']);
    });

    it('skips blank lines rather than framing empty messages', () => {
        client.emit('data', Buffer.from('\n  \n{"a":1}\n'));
        expect(stdoutChunks).toHaveLength(1);
        expect(stdoutChunks[0].subarray(4).toString('utf8')).toBe('{"a":1}');
    });

    it('writes the header as the payload byte length, not character count', () => {
        const line = '{"name":"pâsswörd № 1"}';
        client.emit('data', Buffer.from(line + '\n', 'utf8'));
        expect(stdoutChunks).toHaveLength(1);
        expect(stdoutChunks[0].readUInt32LE(0)).toBe(Buffer.byteLength(line));
        expect(stdoutChunks[0].length).toBe(4 + Buffer.byteLength(line));
    });
});

describe('lifecycle', () => {
    it('exits with 1 when the socket errors', () => {
        expectExit(() => client.emit('error', new Error('refused')), 1);
    });

    it('exits with 0 when the socket closes', () => {
        expectExit(() => client.emit('close'), 0);
    });

    it('exits with 0 when the browser closes stdin', () => {
        expectExit(() => stdin.emit('end'), 0);
    });
});

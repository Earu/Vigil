import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, pbkdf2Sync } from 'crypto';

// YKOATH over a fake card. The fake answers APDUs the way a YubiKey 5 does,
// with the byte layouts recorded from a real key (see the fixtures), so the
// driver's framing, TLV parsing, truncation and failure mapping are pinned
// without hardware. Anything the fake cannot know, it takes from the request:
// a CALCULATE answers with a code derived from the name, so the test can see
// which credential the driver asked about.

// ---- fixtures recorded from a YubiKey 5Ci, firmware 5.7.1 ----

// SELECT: version 5.7.1, device id, no challenge (no password set)
const SELECT_UNLOCKED = '79030507017108cd7e92ab01cb02e2';
// LIST with seven credentials, as the key returned it
const LIST_SEVEN =
    '721121766967696c2d746573743a706c61696e' +      // 0x21 TOTP|SHA1 "vigil-test:plain"
    '721521766967696c2d746573743a6f64642c206e616d65' + // "vigil-test:odd, name"
    '721011766967696c2d746573743a686f7470' +          // 0x11 HOTP|SHA1 "vigil-test:hotp"
    '721121766967696c2d746573743a746f756368' +        // "vigil-test:touch"
    '72132136302f766967696c2d746573743a736c6f77' +    // "60/vigil-test:slow"
    '721221766967696c2d746573743a707573686564' +      // "vigil-test:pushed"
    '720f11686f747020746573743a686f7470';             // HOTP "hotp test:hotp"

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));
const tlv = (tag: number, value: Uint8Array) => cat(Uint8Array.from([tag, value.length]), value);
const sw = (code: number) => Uint8Array.from([code >> 8, code & 0xff]);

class FakePcscError extends Error {
    constructor(public code: string) { super(code); this.name = 'PcscError'; }
}

interface FakeOptions {
    // A password set on the applet: SELECT carries a challenge, VALIDATE is required
    password?: string;
    // Fail the first N connects with this code, then succeed
    contendFirst?: number;
    // Cut LIST into two replies joined by SEND REMAINING
    chunkList?: boolean;
    // What PUT answers with
    putSw?: number;
    // Every LIST reply, and every SEND REMAINING after it, says there is more
    endlessMoreData?: boolean;
}

const DEVICE_ID = hex('cd7e92ab01cb02e2');
const CHALLENGE = hex('0102030405060708');

// The fake's state, inspected by tests
const state = {
    options: {} as FakeOptions,
    transmitted: [] as Uint8Array[],
    puts: [] as Uint8Array[],
    connects: 0,
    disconnects: 0,
    transactions: { begun: 0, ended: 0 },
    list: LIST_SEVEN,
};

function answer(apdu: Uint8Array): Uint8Array {
    const ins = apdu[1];
    const p1 = apdu[2];
    const data = apdu.length > 5 ? apdu.subarray(5, 5 + apdu[4]) : new Uint8Array(0);
    const { password, chunkList } = state.options;

    if (ins === 0xa4 && p1 === 0x04) {
        const body = hex(SELECT_UNLOCKED);
        if (!password) return cat(body, sw(0x9000));
        return cat(body, tlv(0x74, CHALLENGE), tlv(0x7b, Uint8Array.from([0x01])), sw(0x9000));
    }
    if (ins === 0xa3) {
        // VALIDATE: check the response to our challenge, answer theirs
        const key = pbkdf2Sync(password ?? '', Buffer.from(DEVICE_ID), 1000, 16, 'sha1');
        const expected = createHmac('sha1', key).update(CHALLENGE).digest();
        const theirs = Buffer.from(data.subarray(2, 2 + data[1]));
        if (!theirs.equals(expected)) return sw(0x6982);
        const ourChallengeTag = 2 + data[1];
        const ourChallenge = data.subarray(ourChallengeTag + 2, ourChallengeTag + 2 + data[ourChallengeTag + 1]);
        return cat(tlv(0x75, createHmac('sha1', key).update(ourChallenge).digest()), sw(0x9000));
    }
    if (state.options.endlessMoreData && (ins === 0xa1 || ins === 0xa5)) {
        return cat(tlv(0x72, Uint8Array.from([0x21, 0x78])), sw(0x6100 | 0x10));
    }
    if (ins === 0xa1) {
        const list = hex(state.list);
        if (!chunkList) return cat(list, sw(0x9000));
        const cut = Math.floor(list.length / 2);
        state.pendingRemainder = list.subarray(cut);
        return cat(list.subarray(0, cut), sw(0x6100 | (list.length - cut)));
    }
    if (ins === 0xa5) {
        const rest = state.pendingRemainder ?? new Uint8Array(0);
        state.pendingRemainder = undefined;
        return cat(rest, sw(0x9000));
    }
    if (ins === 0xa4 && p1 === 0x00) {
        // CALCULATE ALL: one entry per listed credential. Recorded layout:
        // TOTP -> 0x76 [digits][4 bytes], HOTP -> 0x77 [digits], touch -> 0x7c [digits]
        const out: Uint8Array[] = [];
        for (const { name, type } of listedCredentials()) {
            out.push(tlv(0x71, utf8(name)));
            if (name.includes('touch') || name.includes('pushed')) out.push(tlv(0x7c, Uint8Array.from([6])));
            else if (type === 'HOTP') out.push(tlv(0x77, Uint8Array.from([6])));
            else out.push(tlv(0x76, Uint8Array.from([6, 0x00, 0x02, 0xea, 0x40]))); // 191040
        }
        return cat(...out, sw(0x9000));
    }
    if (ins === 0xa2) {
        // CALCULATE one: answer with a code that encodes the name's length,
        // so the test can tell which credential was asked for
        const name = new TextDecoder().decode(data.subarray(2, 2 + data[1]));
        if (!listedCredentials().some(c => c.name === name)) return sw(0x6984);
        if (name.includes('touch')) return sw(0x6982);
        return cat(tlv(0x76, Uint8Array.from([6, 0, 0, 0, name.length])), sw(0x9000));
    }
    if (ins === 0x01) {
        state.puts.push(data);
        return sw(state.options.putSw ?? 0x9000);
    }
    return sw(0x6d00);
}

function listedCredentials(): Array<{ name: string; type: 'TOTP' | 'HOTP' }> {
    const bytes = hex(state.list);
    const out: Array<{ name: string; type: 'TOTP' | 'HOTP' }> = [];
    let i = 0;
    while (i + 2 <= bytes.length) {
        const length = bytes[i + 1];
        out.push({
            name: new TextDecoder().decode(bytes.subarray(i + 3, i + 2 + length)),
            type: (bytes[i + 2] & 0xf0) === 0x10 ? 'HOTP' : 'TOTP',
        });
        i += 2 + length;
    }
    return out;
}

vi.mock('../electron/native/pcsc', () => ({
    isLoaded: () => true,
    listReaders: async () => ['Yubico YubiKey OTP+FIDO+CCID 00 00'],
    connect: async () => {
        state.connects++;
        if (state.options.contendFirst && state.connects <= state.options.contendFirst) {
            throw new FakePcscError('sharing-violation');
        }
        return {
            handle: state.connects,
            protocol: 2,
            transmit: async (apdu: Uint8Array) => { state.transmitted.push(apdu); return answer(apdu); },
            beginTransaction: async () => { state.transactions.begun++; },
            endTransaction: async () => { state.transactions.ended++; },
            disconnect: async () => { state.disconnects++; },
        };
    },
}));

import {
    readAccounts, calculateCode, pushAccount, listKeys,
    base32Decode, formatCode, splitId, formatId, prepareKey, parseTlvs,
} from '../electron/src/yubikey-oath';

beforeEach(() => {
    state.options = {};
    state.transmitted = [];
    state.puts = [];
    state.connects = 0;
    state.disconnects = 0;
    state.transactions = { begun: 0, ended: 0 };
    state.list = LIST_SEVEN;
});

describe('pure pieces', () => {
    it('parses the recorded SELECT response', () => {
        const tlvs = parseTlvs(hex(SELECT_UNLOCKED));
        expect(tlvs.map(t => t.tag)).toEqual([0x79, 0x71]);
        expect(Array.from(tlvs[0].value)).toEqual([5, 7, 1]);
    });

    it('formats a truncated response the way the service expects', () => {
        // Recorded: 60/vigil-test:slow -> 06 0000386b, ykman printed 014443
        expect(formatCode(hex('060000386b'))).toBe('014443');
        expect(formatCode(hex('060002ea40'))).toBe('191040');
        // Eight digits keep their leading zeros too
        expect(formatCode(hex('0800000007'))).toBe('00000007');
    });

    it('splits ids the way the key names them', () => {
        expect(splitId('vigil-test:plain')).toEqual({ issuer: 'vigil-test', name: 'plain', period: 30 });
        expect(splitId('60/vigil-test:slow')).toEqual({ issuer: 'vigil-test', name: 'slow', period: 60 });
        expect(splitId('vigil-test:odd, name')).toEqual({ issuer: 'vigil-test', name: 'odd, name', period: 30 });
        expect(splitId('bare')).toEqual({ issuer: null, name: 'bare', period: 30 });
        // A colon in the name splits at the first one, as the reference does
        expect(splitId('a:b:c')).toEqual({ issuer: 'a', name: 'b:c', period: 30 });
    });

    it('builds ids the same way, and only prefixes a non-default TOTP period', () => {
        expect(formatId('vigil-test', 'slow', 'TOTP', 60)).toBe('60/vigil-test:slow');
        expect(formatId('vigil-test', 'plain', 'TOTP', 30)).toBe('vigil-test:plain');
        expect(formatId('vigil-test', 'hotp', 'HOTP', 60)).toBe('vigil-test:hotp');
        expect(formatId(null, 'bare', 'TOTP', 30)).toBe('bare');
    });

    it('decodes base32 with the padding and spacing people paste', () => {
        expect(Buffer.from(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toString()).toBe('12345678901234567890');
        expect(Buffer.from(base32Decode('gezd gnbv gy3t qojq====')).toString()).toBe('1234567890');
        expect(() => base32Decode('not base32!')).toThrow();
    });

    it('prepares HMAC keys as the applet requires', () => {
        expect(prepareKey(new Uint8Array(5), 'sha1').length).toBe(14);
        expect(prepareKey(new Uint8Array(20), 'sha1').length).toBe(20);
        // Longer than the block is hashed down to the digest size
        expect(prepareKey(new Uint8Array(100), 'sha1').length).toBe(20);
        expect(prepareKey(new Uint8Array(100), 'sha256').length).toBe(32);
        expect(prepareKey(new Uint8Array(200), 'sha512').length).toBe(64);
        // Exactly the block size is left alone
        expect(prepareKey(new Uint8Array(64), 'sha1').length).toBe(64);
    });
});

describe('readAccounts', () => {
    it('reads every credential in one transaction, with codes only where the key volunteers them', async () => {
        const result = await readAccounts(null, null);
        expect(result.ok).toBe(true);
        const byId = new Map(result.value!.map(a => [a.id, a]));
        expect([...byId.keys()]).toEqual([
            'vigil-test:plain', 'vigil-test:odd, name', 'vigil-test:hotp', 'vigil-test:touch',
            '60/vigil-test:slow', 'vigil-test:pushed', 'hotp test:hotp',
        ]);
        expect(byId.get('vigil-test:plain')).toMatchObject({ issuer: 'vigil-test', name: 'plain', type: 'TOTP', period: 30, code: '191040', requiresTouch: false });
        expect(byId.get('vigil-test:odd, name')).toMatchObject({ name: 'odd, name', code: '191040' });
        expect(byId.get('vigil-test:hotp')).toMatchObject({ type: 'HOTP', code: null, requiresTouch: false });
        expect(byId.get('vigil-test:touch')).toMatchObject({ type: 'TOTP', code: null, requiresTouch: true });
        expect(byId.get('vigil-test:pushed')).toMatchObject({ code: null, requiresTouch: true });
        // One connection, one transaction, released afterwards
        expect(state.connects).toBe(1);
        expect(state.transactions).toEqual({ begun: 1, ended: 1 });
        expect(state.disconnects).toBe(1);
    });

    // CALCULATE ALL has one time step, so a credential with another period
    // gets its own CALCULATE with the right step
    it('recalculates non-default periods individually', async () => {
        const result = await readAccounts(null, null);
        const slow = result.value!.find(a => a.id === '60/vigil-test:slow')!;
        // The fake encodes the asked-for name's length in the code
        expect(slow.code).toBe(String('60/vigil-test:slow'.length).padStart(6, '0'));
        expect(slow.period).toBe(60);
        const calculates = state.transmitted.filter(a => a[1] === 0xa2);
        expect(calculates).toHaveLength(1);
    });

    it('never asks the key to calculate an HOTP or touch credential on a read', async () => {
        await readAccounts(null, null);
        const asked = state.transmitted
            .filter(a => a[1] === 0xa2)
            .map(a => new TextDecoder().decode(a.subarray(7, 7 + a[6])));
        expect(asked).toEqual(['60/vigil-test:slow']);
    });

    it('begins every transaction with SELECT', async () => {
        await readAccounts(null, null);
        expect(state.transmitted[0][1]).toBe(0xa4);
        expect(state.transmitted[0][2]).toBe(0x04);
        expect(Array.from(state.transmitted[0].subarray(5))).toEqual([0xa0, 0x00, 0x00, 0x05, 0x27, 0x21, 0x01]);
    });

    it('assembles a response split across SEND REMAINING', async () => {
        state.options.chunkList = true;
        const result = await readAccounts(null, null);
        expect(result.ok).toBe(true);
        expect(result.value).toHaveLength(7);
        expect(state.transmitted.some(a => a[1] === 0xa5)).toBe(true);
    });

    it('reports an empty key as an empty list', async () => {
        state.list = '';
        const result = await readAccounts(null, null);
        expect(result).toEqual({ ok: true, value: [] });
    });

    it('retries once when another process has the card', async () => {
        state.options.contendFirst = 1;
        const result = await readAccounts(null, null);
        expect(result.ok).toBe(true);
        expect(state.connects).toBe(2);
    });

    it('gives up after one retry', async () => {
        state.options.contendFirst = 2;
        const result = await readAccounts(null, null);
        expect(result).toMatchObject({ ok: false, error: 'in-use' });
    });
});

describe('a password-protected applet', () => {
    it('asks for the password before reading', async () => {
        state.options.password = 'hunter2';
        expect(await readAccounts(null, null)).toMatchObject({ ok: false, error: 'locked' });
        // Nothing beyond SELECT was sent to a locked applet
        expect(state.transmitted.map(a => a[1])).toEqual([0xa4]);
    });

    it('authenticates with the right password and rejects the wrong one', async () => {
        state.options.password = 'hunter2';
        expect((await readAccounts(null, 'hunter2')).ok).toBe(true);
        expect(await readAccounts(null, 'nope')).toMatchObject({ ok: false, error: 'wrong-password' });
    });
});

describe('calculateCode', () => {
    it('calculates one credential and does not retry', async () => {
        state.options.contendFirst = 1;
        const result = await calculateCode(null, 'vigil-test:hotp', null);
        expect(result).toMatchObject({ ok: false, error: 'in-use' });
        expect(state.connects).toBe(1);
    });

    it('sends an empty challenge for HOTP and a time step for TOTP', async () => {
        await calculateCode(null, 'vigil-test:hotp', null);
        const hotp = state.transmitted.find(a => a[1] === 0xa2)!;
        const challengeOffset = 5 + 2 + hotp[6];
        expect(hotp[challengeOffset]).toBe(0x74);
        expect(hotp[challengeOffset + 1]).toBe(0);

        state.transmitted = [];
        await calculateCode(null, '60/vigil-test:slow', null);
        const totp = state.transmitted.find(a => a[1] === 0xa2)!;
        const offset = 5 + 2 + totp[6];
        expect(totp[offset]).toBe(0x74);
        expect(totp[offset + 1]).toBe(8);
    });

    it('maps a touch that never came to timeout, and a missing credential to not-found', async () => {
        expect(await calculateCode(null, 'vigil-test:touch', null)).toMatchObject({ ok: false, error: 'timeout' });
        expect(await calculateCode(null, 'gone:gone', null)).toMatchObject({ ok: false, error: 'not-found' });
    });
});

describe('pushAccount', () => {
    const request = {
        issuer: 'GitHub', name: 'ryan', type: 'TOTP' as const, digits: 6,
        algorithm: 'SHA-1', period: 30, counter: 0, requireTouch: true,
    };
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    it('encodes PUT the way the applet expects', async () => {
        const result = await pushAccount(null, request, secret, null);
        expect(result).toEqual({ ok: true, value: true });
        const data = state.puts[0];
        const tlvs = parseTlvs(data.subarray(0, data.length - 2));
        expect(new TextDecoder().decode(tlvs[0].value)).toBe('GitHub:ryan');
        // key: [TOTP|SHA1][digits][secret]
        expect(tlvs[1].tag).toBe(0x73);
        expect(tlvs[1].value[0]).toBe(0x21);
        expect(tlvs[1].value[1]).toBe(6);
        expect(Buffer.from(tlvs[1].value.subarray(2)).toString()).toBe('12345678901234567890');
        // The property tag has no length byte: two trailing bytes
        expect(Array.from(data.subarray(data.length - 2))).toEqual([0x78, 0x02]);
    });

    it('carries the initial counter for HOTP and the period prefix for slow TOTP', async () => {
        await pushAccount(null, { ...request, type: 'HOTP', counter: 42, requireTouch: false }, secret, null);
        const hotp = parseTlvs(state.puts[0]);
        expect(hotp.find(t => t.tag === 0x7a)!.value).toEqual(Uint8Array.from([0, 0, 0, 42]));

        await pushAccount(null, { ...request, period: 60, requireTouch: false }, secret, null);
        const slow = parseTlvs(state.puts[1]);
        expect(new TextDecoder().decode(slow[0].value)).toBe('60/GitHub:ryan');
    });

    it('reports a full key', async () => {
        state.options.putSw = 0x6a84;
        expect(await pushAccount(null, request, secret, null)).toMatchObject({ ok: false, error: 'no-space' });
    });

    it('refuses what the applet cannot hold before touching the key', async () => {
        expect(await pushAccount(null, { ...request, algorithm: 'MD5' }, secret, null)).toMatchObject({ ok: false, error: 'failed' });
        expect(await pushAccount(null, { ...request, digits: 9 }, secret, null)).toMatchObject({ ok: false, error: 'failed' });
        expect(await pushAccount(null, request, 'not base32!', null)).toMatchObject({ ok: false, error: 'failed' });
        expect(await pushAccount(null, { ...request, name: 'x'.repeat(70) }, secret, null)).toMatchObject({ ok: false, error: 'failed' });
        expect(state.connects).toBe(0);
    });
});

describe('a broken or hostile card', () => {
    it('gives up on a response that never ends instead of looping forever', async () => {
        state.options.endlessMoreData = true;
        const result = await readAccounts(null, null);
        expect(result).toMatchObject({ ok: false, error: 'failed' });
        // Bounded: a few hundred round trips at most, not until the heap is gone
        expect(state.transmitted.filter(a => a[1] === 0xa5).length).toBeLessThanOrEqual(257);
        // And the card was still released
        expect(state.transactions.ended).toBe(1);
        expect(state.disconnects).toBe(1);
    });
});

describe('pushAccount input', () => {
    const request = {
        issuer: 'GitHub', name: 'ryan', type: 'TOTP' as const, digits: 6,
        algorithm: 'SHA-1', period: 30, counter: 0, requireTouch: true,
    };
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    // A default-period id has no period prefix, so an issuer that starts
    // with digits and a slash would be read back as one
    it('refuses a name the key would read back as a period', async () => {
        expect(await pushAccount(null, { ...request, issuer: '60/GitHub' }, secret, null)).toMatchObject({ ok: false, error: 'failed' });
        expect(state.connects).toBe(0);
        // With an explicit period the prefix is ours and comes first; the name is safe
        expect((await pushAccount(null, { ...request, issuer: '60/GitHub', period: 60 }, secret, null)).ok).toBe(true);
    });

    it('rejects a malformed request before touching the key', async () => {
        const bad: any[] = [
            { ...request, name: 12 },
            { ...request, type: 'STEAM' },
            { ...request, digits: '6' },
            { ...request, period: 0 },
            { ...request, counter: -1 },
            { ...request, requireTouch: 'yes' },
            { ...request, issuer: 5 },
            null,
        ];
        for (const r of bad) {
            expect(await pushAccount(null, r, secret, null)).toMatchObject({ ok: false, error: 'failed', detail: 'malformed request' });
        }
        expect(await pushAccount(null, request, 42 as any, null)).toMatchObject({ ok: false, error: 'failed' });
        expect(state.connects).toBe(0);
    });
});

describe('listKeys', () => {
    it('names the connected YubiKey readers', async () => {
        expect(await listKeys()).toEqual({ ok: true, value: ['Yubico YubiKey OTP+FIDO+CCID 00 00'] });
    });
});

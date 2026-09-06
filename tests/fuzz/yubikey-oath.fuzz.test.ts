import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { settings, anyText, anyValue, bytes } from './fuzz';

// YKOATH responses come off a removable device, over a connection every other
// process on the machine shares, and the credential ids in them are the only
// input to the period and the digit count every code is computed with. The
// driver's own tests (tests/yubikey-oath.test.ts) pin it against responses
// recorded from a real key; this pins what it does when the card says
// something no real key would. The id also arrives from the renderer, on the
// yubikey-oath-code channel, so the same parsing answers two callers.

const DEFAULT_PERIOD = 30;
const MAX_PERIOD = 24 * 60 * 60;
const MAX_ID_BYTES = 64;

const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};
const utf8 = (text: string) => new TextEncoder().encode(text);
const sw = (code: number) => Uint8Array.from([code >> 8, code & 0xff]);
const tlv = (tag: number, value: Uint8Array) => cat(Uint8Array.from([tag, value.length]), value);

// SELECT as a YubiKey 5 answers it with no password set, so a property can
// get the driver past authentication and on to the parsing it wants to reach
const SELECT_OK = Uint8Array.from(Buffer.from('79030507017108cd7e92ab01cb02e2', 'hex'));

const INS = { SELECT: 0xa4, LIST: 0xa1, CALCULATE: 0xa2, PUT: 0x01 } as const;
const TAG = { NAME: 0x71, NAME_LIST: 0x72, KEY: 0x73, TRUNCATED: 0x76 } as const;

// What the fake card answers with. Referenced only inside the transmit
// callback, so the mock factory can close over it before it is assigned
let respond: (apdu: Uint8Array) => Uint8Array = () => sw(0x9000);
let transmitted: Uint8Array[] = [];

vi.mock('../../electron/native/pcsc', () => ({
    isLoaded: () => true,
    listReaders: async () => ['Yubico YubiKey OTP+FIDO+CCID 00 00'],
    connect: async () => ({
        handle: 1,
        protocol: 2,
        transmit: async (apdu: Uint8Array) => { transmitted.push(apdu); return respond(apdu); },
        beginTransaction: async () => undefined,
        endTransaction: async () => undefined,
        disconnect: async () => undefined,
    }),
}));

import {
    readAccounts, calculateCode, pushAccount,
    parseTlvs, splitId, formatId, formatCode, base32Decode, prepareKey,
} from '../../electron/src/yubikey-oath';

beforeEach(() => {
    transmitted = [];
    respond = () => sw(0x9000);
});

// A card that answers the applet's own framing, with the credential list and
// the calculated values a property hands it
type Credential = { id: string; typeByte: number; digits: number; value: Uint8Array; tag: number };

const cardAnswering = (credentials: Credential[]) => (apdu: Uint8Array): Uint8Array => {
    const ins = apdu[1];
    const p1 = apdu[2];
    if (ins === INS.SELECT && p1 === 0x04) return cat(SELECT_OK, sw(0x9000));
    if (ins === INS.LIST) {
        return cat(...credentials.map(c => tlv(TAG.NAME_LIST, cat(Uint8Array.from([c.typeByte]), utf8(c.id)))), sw(0x9000));
    }
    // CALCULATE ALL: a name and then whatever value tag the property chose
    if (ins === INS.SELECT && p1 === 0x00) {
        return cat(...credentials.flatMap(c => [tlv(TAG.NAME, utf8(c.id)), tlv(c.tag, c.value)]), sw(0x9000));
    }
    if (ins === INS.CALCULATE) {
        const first = credentials[0];
        return cat(tlv(TAG.TRUNCATED, Uint8Array.from([first.digits, 0x01, 0x02, 0x03, 0x04])), sw(0x9000));
    }
    return sw(0x9000);
};

// Text of every shape a credential id comes in: the applet's own
// `[period/]issuer:name`, with periods no time step can use, and anything
// else a card or the renderer might send
const credentialId = (): fc.Arbitrary<string> => fc.oneof(
    { weight: 2, arbitrary: anyText() },
    {
        weight: 3, arbitrary: fc.tuple(
            fc.option(fc.constantFrom('0', '00', '1', '30', '60', '9'.repeat(20), '0'.repeat(30)), { nil: null }),
            fc.option(fc.string({ maxLength: 12 }), { nil: null }),
            fc.string({ maxLength: 12 }),
        ).map(([period, issuer, name]) => `${period === null ? '' : `${period}/`}${issuer === null ? '' : `${issuer}:`}${name}`),
    },
);

const credential = (): fc.Arbitrary<Credential> => fc.record({
    // Short enough that its UTF-8 always fits a single-byte TLV length
    id: credentialId().filter(id => new TextEncoder().encode(id).length <= 200),
    typeByte: fc.integer({ min: 0, max: 255 }),
    digits: fc.integer({ min: 0, max: 255 }),
    value: fc.uint8Array({ maxLength: 8 }),
    tag: fc.integer({ min: 0x70, max: 0x7f }),
});

describe('YKOATH parsing under fuzz', () => {
    it('parseTlvs reads its input in place or refuses it, and never invents a byte', () => {
        fc.assert(fc.property(bytes(512), data => {
            let tlvs: Array<{ tag: number; value: Uint8Array }>;
            try {
                tlvs = parseTlvs(data);
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                return;
            }
            let offset = 0;
            for (const { tag, value } of tlvs) {
                expect(tag).toBe(data[offset]);
                expect(value.length).toBe(data[offset + 1]);
                expect([...value]).toEqual([...data.subarray(offset + 2, offset + 2 + value.length)]);
                offset += 2 + value.length;
            }
            // Only a lone trailing byte can be left: anything more is a TLV
            // that was skipped rather than read
            expect(data.length - offset).toBeLessThan(2);
        }), settings());
    });

    it('a period from any credential id is one a time step can divide by', () => {
        fc.assert(fc.property(credentialId(), id => {
            const { issuer, name, period } = splitId(id);
            expect(Number.isInteger(period)).toBe(true);
            expect(period).toBeGreaterThan(0);
            expect(period).toBeLessThanOrEqual(MAX_PERIOD);
            expect(typeof name).toBe('string');
            expect(issuer === null || typeof issuer === 'string').toBe(true);
        }), settings());
    });

    it('an id the write path builds reads back as the credential it was built from', () => {
        fc.assert(fc.property(
            fc.option(fc.string({ maxLength: 20 }).filter(s => s.length > 0 && !s.includes(':') && !/^\d+\//.test(s)), { nil: null }),
            fc.string({ maxLength: 20 }).filter(s => !/^\d+\//.test(s)),
            fc.integer({ min: 1, max: MAX_PERIOD }),
            (issuer, name, period) => {
                // With no issuer the first colon is the name's own, and the
                // split cannot know that; the write path names its issuer
                fc.pre(issuer !== null || !name.includes(':'));
                expect(splitId(formatId(issuer, name, 'TOTP', period))).toEqual({ issuer, name, period });
            },
        ), settings());
    });

    it('formatCode answers null or a code of exactly the digit count it names', () => {
        fc.assert(fc.property(fc.uint8Array({ minLength: 5, maxLength: 5 }), truncated => {
            const code = formatCode(truncated);
            if (code === null) {
                expect(truncated[0] < 6 || truncated[0] > 8).toBe(true);
                return;
            }
            expect(code).toMatch(/^\d+$/);
            expect(code.length).toBe(truncated[0]);
            expect(truncated[0]).toBeGreaterThanOrEqual(6);
            expect(truncated[0]).toBeLessThanOrEqual(8);
        }), settings());
    });

    it('base32Decode refuses anything outside the alphabet and never loses a byte', () => {
        fc.assert(fc.property(anyText(), text => {
            let decoded: Uint8Array;
            try {
                decoded = base32Decode(text);
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                // Only a character the alphabet does not hold can refuse it
                expect(/[^A-Za-z2-7\s=-]/.test(text)).toBe(true);
                return;
            }
            const clean = text.toUpperCase().replace(/[\s=-]/g, '');
            expect(decoded.length).toBe(Math.floor(clean.length * 5 / 8));
        }), settings());
    });

    it('prepareKey never hands the applet a key below its minimum or above the block', () => {
        fc.assert(fc.property(
            bytes(300),
            fc.constantFrom('sha1' as const, 'sha256' as const, 'sha512' as const),
            (secret, algorithm) => {
                const block = algorithm === 'sha512' ? 128 : 64;
                const key = prepareKey(secret, algorithm);
                expect(key.length).toBeGreaterThanOrEqual(14);
                expect(key.length).toBeLessThanOrEqual(block);
            },
        ), settings());
    });
});

describe('the YKOATH driver against a card answering anything', () => {
    it('any bytes at all yield a result, never a rejection', async () => {
        await fc.assert(fc.asyncProperty(fc.array(bytes(64), { minLength: 1, maxLength: 6 }), async frames => {
            let i = 0;
            respond = () => frames[i++ % frames.length];
            const result = await readAccounts(null, null);
            expect(typeof result.ok).toBe('boolean');
            if (result.ok) expect(Array.isArray(result.value)).toBe(true);
            else expect(typeof result.error).toBe('string');
        }), settings());
    });

    it('every account a card can name is one the panel can render', async () => {
        await fc.assert(fc.asyncProperty(fc.array(credential(), { minLength: 1, maxLength: 6 }), async credentials => {
            respond = cardAnswering(credentials);
            const result = await readAccounts(null, null);
            expect(typeof result.ok).toBe('boolean');
            for (const account of result.value ?? []) {
                expect(typeof account.id).toBe('string');
                expect(typeof account.name).toBe('string');
                expect(account.issuer === null || typeof account.issuer === 'string').toBe(true);
                expect(account.type === 'TOTP' || account.type === 'HOTP').toBe(true);
                expect(Number.isInteger(account.period)).toBe(true);
                expect(account.period).toBeGreaterThan(0);
                expect(account.period).toBeLessThanOrEqual(MAX_PERIOD);
                expect(account.code === null || /^\d{6,8}$/.test(account.code)).toBe(true);
                expect(typeof account.requiresTouch).toBe('boolean');
            }
        }), settings());
    });

    it('an id from the renderer is answered rather than thrown over', async () => {
        await fc.assert(fc.asyncProperty(credentialId(), fc.array(credential(), { minLength: 1, maxLength: 3 }), async (id, credentials) => {
            respond = cardAnswering(credentials);
            const result = await calculateCode(null, id, null);
            expect(typeof result.ok).toBe('boolean');
            expect(result.ok ? /^\d{6,8}$/.test(result.value!) : typeof result.error === 'string').toBe(true);
        }), settings());
    });

    it('a request the write path refuses never reaches the card, and one it accepts is within the applet limits', async () => {
        await fc.assert(fc.asyncProperty(anyValue(), anyText(), async (request, secret) => {
            transmitted = [];
            respond = cardAnswering([{ id: 'a:b', typeByte: 0x21, digits: 6, value: new Uint8Array(5), tag: TAG.TRUNCATED }]);
            const result = await pushAccount(null, request as never, secret, null);
            expect(typeof result.ok).toBe('boolean');

            const put = transmitted.find(apdu => apdu[1] === INS.PUT);
            if (!put) return;
            const tlvs = parseTlvs(put.subarray(5, 5 + put[4]));
            const name = tlvs.find(t => t.tag === TAG.NAME);
            const key = tlvs.find(t => t.tag === TAG.KEY);
            expect(name!.value.length).toBeLessThanOrEqual(MAX_ID_BYTES);
            // The key TLV is [type|algorithm][digits] and then the secret
            expect(key!.value[1]).toBeGreaterThanOrEqual(6);
            expect(key!.value[1]).toBeLessThanOrEqual(8);
        }), settings());
    });

    it('a credential whose id names no usable period is read at the default rather than failing the list', async () => {
        await fc.assert(fc.asyncProperty(
            fc.constantFrom('0', '00', '000000000000000000000000000000', '99999999999'),
            async prefix => {
                respond = cardAnswering([{ id: `${prefix}/issuer:name`, typeByte: 0x21, digits: 6, value: Uint8Array.from([6, 0, 0, 0, 7]), tag: TAG.TRUNCATED }]);
                const result = await readAccounts(null, null);
                expect(result.ok).toBe(true);
                expect(result.value).toHaveLength(1);
                expect(result.value![0].period).toBe(DEFAULT_PERIOD);
                expect(result.value![0].code).toBe('000007');
            },
        ), settings());
    });
});

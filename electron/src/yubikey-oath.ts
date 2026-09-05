import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';
import * as pcsc from '../native/pcsc';
import type { Card } from '../native/pcsc';

// The OATH application on a YubiKey, over PC/SC. YKOATH is a small ISO 7816
// protocol (https://developers.yubico.com/OATH/YKOATH_Protocol.html): SELECT
// the applet, then LIST, CALCULATE, PUT and friends as TLV-encoded APDUs.
// The transport is electron/native/pcsc; everything about the protocol is
// here, in TypeScript, where it is tested against responses recorded from a
// real key.
//
// The connection is shared with every other process on the machine, and any
// of them can SELECT a different applet between two of our commands. So each
// operation is one transaction that starts with SELECT, and the driver never
// keeps a card open between operations.
//
// Reads are the bulk of this. The one write, pushAccount, copies a secret
// the vault already holds onto the key; the vault keeps its copy, because no
// command in the protocol reads a secret back and that vault copy is the only
// backup that will ever exist. Nothing here can move a secret the other way.

const AID = Uint8Array.from([0xa0, 0x00, 0x00, 0x05, 0x27, 0x21, 0x01]);

const INS = {
    PUT: 0x01,
    SELECT: 0xa4,
    LIST: 0xa1,
    CALCULATE: 0xa2,
    VALIDATE: 0xa3,
    CALCULATE_ALL: 0xa4,
    SEND_REMAINING: 0xa5,
} as const;

const TAG = {
    NAME: 0x71,
    NAME_LIST: 0x72,
    KEY: 0x73,
    CHALLENGE: 0x74,
    RESPONSE: 0x75,
    TRUNCATED: 0x76,
    HOTP: 0x77,
    PROPERTY: 0x78,
    VERSION: 0x79,
    IMF: 0x7a,
    ALGORITHM: 0x7b,
    TOUCH: 0x7c,
} as const;

const TYPE_HOTP = 0x10;
const TYPE_TOTP = 0x20;
const PROPERTY_REQUIRE_TOUCH = 0x02;

const SW = {
    OK: 0x9000,
    // High byte of "the key holds more; fetch it with SEND REMAINING"
    MORE_DATA: 0x61,
    AUTH_REQUIRED: 0x6982,
    NO_SPACE: 0x6a84,
    NO_SUCH_OBJECT: 0x6984,
} as const;

const DEFAULT_PERIOD = 30;
// HMAC keys shorter than this are padded, as the applet requires
const MIN_KEY_BYTES = 14;
// The applet's own limit on a credential id
const MAX_ID_BYTES = 64;
// A response is at most a few KiB of names; a card that keeps saying "more"
// is broken or hostile, and must not hold the loop or the heap
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REMAINING_ROUNDS = 256;

type HashName = 'sha1' | 'sha256' | 'sha512';
const ALGORITHM_BYTE: Record<HashName, number> = { sha1: 0x01, sha256: 0x02, sha512: 0x03 };
const ALGORITHM_NAME: Record<number, HashName> = { 0x01: 'sha1', 0x02: 'sha256', 0x03: 'sha512' };
const HMAC_BLOCK_BYTES: Record<HashName, number> = { sha1: 64, sha256: 64, sha512: 128 };

export type OathType = 'TOTP' | 'HOTP';

export interface OathAccount {
    // The credential id as the key stores it: `[period/]issuer:name`. Both
    // halves below are derived from it for display only
    id: string;
    issuer: string | null;
    name: string;
    type: OathType;
    period: number;
    // null when the key would not hand one over unprompted: HOTP accounts
    // (calculating one burns a counter) and touch-required ones
    code: string | null;
    requiresTouch: boolean;
}

export type OathFailure =
    // The transport addon is not built or its library is missing
    | 'unavailable'
    | 'no-pcscd'
    | 'no-key'
    | 'locked'
    | 'wrong-password'
    | 'timeout'
    | 'in-use'
    | 'no-space'
    | 'not-found'
    | 'failed';

export interface OathResult<T> {
    ok: boolean;
    value?: T;
    error?: OathFailure;
    detail?: string;
}

export interface PushRequest {
    // Together these form the credential id the key files it under
    issuer: string | null;
    name: string;
    type: OathType;
    digits: number;
    // 'SHA-1' style, as the vault stores it
    algorithm: string;
    period: number;
    counter: number;
    // Always set by the panel today. Touch is the only thing that makes a
    // credential on the key harder to abuse than one in the vault: without
    // it, anything running as the user can mint codes while the key is in
    requireTouch: boolean;
}

// ---- byte helpers ----

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

// YKOATH values are all short; a single-byte length is what the key emits and
// accepts
const tlv = (tag: number, value: Uint8Array): Uint8Array => {
    if (value.length > 0xff) throw new Error('TLV value too long');
    return concat(Uint8Array.from([tag, value.length]), value);
};

interface Tlv { tag: number; value: Uint8Array }

export function parseTlvs(data: Uint8Array): Tlv[] {
    const out: Tlv[] = [];
    let i = 0;
    while (i + 2 <= data.length) {
        const tag = data[i];
        const length = data[i + 1];
        if (i + 2 + length > data.length) throw new Error('truncated TLV');
        out.push({ tag, value: data.subarray(i + 2, i + 2 + length) });
        i += 2 + length;
    }
    return out;
}

const be64 = (n: number): Uint8Array => {
    const out = new Uint8Array(8);
    let x = BigInt(n);
    for (let i = 7; i >= 0; i--) {
        out[i] = Number(x & 0xffn);
        x >>= 8n;
    }
    return out;
};

const be32 = (n: number): Uint8Array => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648, tolerant of the spacing and padding people paste in
export function base32Decode(text: string): Uint8Array {
    const clean = text.toUpperCase().replace(/[\s=-]/g, '');
    const out: number[] = [];
    let bits = 0;
    let acc = 0;
    for (const ch of clean) {
        const v = BASE32.indexOf(ch);
        if (v === -1) throw new Error('not base32');
        acc = ((acc << 5) | v) & 0xffff;
        bits += 5;
        if (bits >= 8) {
            out.push((acc >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}

// The code as the service expects it: the 31-bit value the key returns,
// reduced to the credential's digit count and zero-padded
export function formatCode(truncated: Uint8Array): string {
    const digits = truncated[0];
    const value = ((truncated[1] << 24) | (truncated[2] << 16) | (truncated[3] << 8) | truncated[4]) >>> 0;
    return String(value % 10 ** digits).padStart(digits, '0');
}

// `issuer:name`, or `<period>/issuer:name` when the period is not the default.
// Neither half is escaped, so a name holding a colon splits at the first one,
// the same way the reference implementation does
export function splitId(id: string): { issuer: string | null; name: string; period: number } {
    const slash = id.match(/^(\d+)\/([\s\S]*)$/);
    const period = slash ? Number(slash[1]) : DEFAULT_PERIOD;
    const rest = slash ? slash[2] : id;
    const colon = rest.indexOf(':');
    if (colon === -1) return { issuer: null, name: rest, period };
    return { issuer: rest.slice(0, colon), name: rest.slice(colon + 1), period };
}

export function formatId(issuer: string | null, name: string, type: OathType, period: number): string {
    let id = '';
    if (type === 'TOTP' && period !== DEFAULT_PERIOD) id += `${period}/`;
    if (issuer) id += `${issuer}:`;
    return id + name;
}

const timeStep = (period: number, nowMs = Date.now()): Uint8Array => be64(Math.floor(nowMs / 1000 / period));

// ---- the applet ----

class ApduError extends Error {
    constructor(public readonly sw: number) {
        super(`sw=${sw.toString(16).padStart(4, '0')}`);
        this.name = 'ApduError';
    }
}

interface Selected {
    version: string;
    deviceId: Uint8Array;
    // Present only when a password is set
    challenge: Uint8Array | null;
    algorithm: HashName;
}

class OathSession {
    constructor(private readonly card: Card) {}

    // One command, with the response body assembled across SEND REMAINING
    // when the key has more than fits in one reply
    async send(ins: number, p1: number, p2: number, data: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
        const header = Uint8Array.from([0x00, ins, p1, p2]);
        let response = await this.card.transmit(data.length > 0 ? concat(header, Uint8Array.from([data.length]), data) : header);
        if (response.length < 2) throw new Error('short response');
        let body = response.subarray(0, response.length - 2);
        let sw = (response[response.length - 2] << 8) | response[response.length - 1];
        let rounds = 0;
        while ((sw >> 8) === SW.MORE_DATA) {
            if (++rounds > MAX_REMAINING_ROUNDS || body.length > MAX_RESPONSE_BYTES) throw new Error('response never ends');
            response = await this.card.transmit(Uint8Array.from([0x00, INS.SEND_REMAINING, 0x00, 0x00]));
            if (response.length < 2) throw new Error('short response');
            body = concat(body, response.subarray(0, response.length - 2));
            sw = (response[response.length - 2] << 8) | response[response.length - 1];
        }
        if (sw !== SW.OK) throw new ApduError(sw);
        return body;
    }

    async select(): Promise<Selected> {
        const tlvs = parseTlvs(await this.send(INS.SELECT, 0x04, 0x00, AID));
        const find = (tag: number) => tlvs.find(t => t.tag === tag)?.value ?? null;
        const version = find(TAG.VERSION);
        const deviceId = find(TAG.NAME);
        if (!version || !deviceId) throw new Error('not an OATH applet');
        const algorithmByte = find(TAG.ALGORITHM)?.[0] ?? ALGORITHM_BYTE.sha1;
        return {
            version: Array.from(version).join('.'),
            deviceId,
            challenge: find(TAG.CHALLENGE),
            algorithm: ALGORITHM_NAME[algorithmByte] ?? 'sha1',
        };
    }

    // Mutual authentication: prove we hold the key derived from the password,
    // and check the applet does too before trusting anything it says next
    async validate(selected: Selected, password: string): Promise<void> {
        if (!selected.challenge) return;
        const key = pbkdf2Sync(password, Buffer.from(selected.deviceId), 1000, 16, 'sha1');
        const ourChallenge = randomBytes(8);
        const response = createHmac(selected.algorithm, key).update(selected.challenge).digest();
        const tlvs = parseTlvs(await this.send(
            INS.VALIDATE, 0x00, 0x00,
            concat(tlv(TAG.RESPONSE, response), tlv(TAG.CHALLENGE, ourChallenge)),
        ));
        const theirs = tlvs.find(t => t.tag === TAG.RESPONSE)?.value;
        const expected = createHmac(selected.algorithm, key).update(ourChallenge).digest();
        if (!theirs || theirs.length !== expected.length || !timingSafeEqual(Buffer.from(theirs), expected)) {
            throw new ApduError(SW.AUTH_REQUIRED);
        }
    }

    async list(): Promise<Array<{ id: string; type: OathType }>> {
        return parseTlvs(await this.send(INS.LIST, 0x00, 0x00))
            .filter(t => t.tag === TAG.NAME_LIST && t.value.length >= 2)
            .map(t => ({
                id: new TextDecoder().decode(t.value.subarray(1)),
                type: (t.value[0] & 0xf0) === TYPE_HOTP ? 'HOTP' : 'TOTP',
            }));
    }

    // Every credential at once, for the default period. Never advances an
    // HOTP counter and never asks for a touch: those come back as markers
    async calculateAll(): Promise<Map<string, { code: string | null; touch: boolean }>> {
        const tlvs = parseTlvs(await this.send(INS.CALCULATE_ALL, 0x00, 0x01, tlv(TAG.CHALLENGE, timeStep(DEFAULT_PERIOD))));
        const out = new Map<string, { code: string | null; touch: boolean }>();
        for (let i = 0; i + 1 < tlvs.length; i += 2) {
            if (tlvs[i].tag !== TAG.NAME) continue;
            const id = new TextDecoder().decode(tlvs[i].value);
            const value = tlvs[i + 1];
            out.set(id, {
                code: value.tag === TAG.TRUNCATED && value.value.length === 5 ? formatCode(value.value) : null,
                touch: value.tag === TAG.TOUCH,
            });
        }
        return out;
    }

    // One credential. This is the call that burns an HOTP counter and that
    // lights the key up for a touch; the transmit blocks until the touch
    // arrives or the key gives up
    async calculate(id: string, type: OathType, period: number): Promise<string> {
        const challenge = type === 'TOTP' ? timeStep(period) : new Uint8Array(0);
        const tlvs = parseTlvs(await this.send(INS.CALCULATE, 0x00, 0x01, concat(tlv(TAG.NAME, utf8(id)), tlv(TAG.CHALLENGE, challenge))));
        const truncated = tlvs.find(t => t.tag === TAG.TRUNCATED)?.value;
        if (!truncated || truncated.length !== 5) throw new Error('no code in response');
        return formatCode(truncated);
    }

    async put(id: string, type: OathType, algorithm: HashName, digits: number, secret: Uint8Array, requireTouch: boolean, counter: number): Promise<void> {
        const typeByte = (type === 'HOTP' ? TYPE_HOTP : TYPE_TOTP) | ALGORITHM_BYTE[algorithm];
        let data = concat(
            tlv(TAG.NAME, utf8(id)),
            tlv(TAG.KEY, concat(Uint8Array.from([typeByte, digits]), secret)),
        );
        // The property tag carries its value directly, with no length byte
        if (requireTouch) data = concat(data, Uint8Array.from([TAG.PROPERTY, PROPERTY_REQUIRE_TOUCH]));
        if (type === 'HOTP' && counter > 0) data = concat(data, tlv(TAG.IMF, be32(counter)));
        await this.send(INS.PUT, 0x00, 0x00, data);
    }
}

// An HMAC key longer than the hash's block is hashed first, which is what
// the HMAC definition does anyway; the applet just wants it done up front.
// Shorter than the minimum is padded with zeros, which HMAC also treats as
// the same key
export function prepareKey(secret: Uint8Array, algorithm: HashName): Uint8Array {
    let key = secret;
    if (key.length > HMAC_BLOCK_BYTES[algorithm]) key = new Uint8Array(createHash(algorithm).update(key).digest());
    if (key.length < MIN_KEY_BYTES) key = concat(key, new Uint8Array(MIN_KEY_BYTES - key.length));
    return key;
}

// ---- failure mapping ----

function mapPcscCode(code: string): OathFailure {
    switch (code) {
        case 'unavailable': return 'unavailable';
        case 'no-service': return 'no-pcscd';
        case 'no-reader':
        case 'no-card': return 'no-key';
        // Another process had the card, or reset it under us; the caller
        // may try once more
        case 'sharing-violation':
        case 'proto-mismatch':
        case 'reset': return 'in-use';
        case 'timeout': return 'timeout';
        default: return 'failed';
    }
}

function mapError(error: unknown, calculating: boolean): OathResult<never> {
    if (error instanceof ApduError) {
        switch (error.sw) {
            // Before authentication this is the applet rejecting the password;
            // on CALCULATE it is a touch that never came
            case SW.AUTH_REQUIRED: return { ok: false, error: calculating ? 'timeout' : 'wrong-password' };
            case SW.NO_SPACE: return { ok: false, error: 'no-space' };
            case SW.NO_SUCH_OBJECT: return { ok: false, error: 'not-found' };
            default: return { ok: false, error: 'failed', detail: error.message };
        }
    }
    if (error instanceof Error && error.name === 'PcscError') {
        const code = (error as Error & { code: string }).code;
        return { ok: false, error: mapPcscCode(code), detail: error.message };
    }
    return { ok: false, error: 'failed', detail: error instanceof Error ? error.message : String(error) };
}

// ---- sessions ----

const isYubiKeyReader = (name: string) => /yubi/i.test(name);

// PC/SC gives the card to one process at a time, and within this process the
// card wrapper refuses overlapping calls outright, so every operation goes
// through this chain
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.then(() => undefined, () => undefined);
    return next;
}

// Any other process on the machine can hold the card mid-call. One retry
// covers the moment Yubico Authenticator or ykman happens to be reading
const CONTENTION_RETRY_MS = 250;

// Connect, open a transaction, SELECT, authenticate if the applet asks, run
// the operation, and always let go of the card afterwards
async function withApplet<T>(
    password: string | null,
    calculating: boolean,
    fn: (session: OathSession, selected: Selected) => Promise<T>,
): Promise<OathResult<T>> {
    if (!pcsc.isLoaded()) return { ok: false, error: 'unavailable' };
    let card: Card | null = null;
    let inTransaction = false;
    try {
        const reader = (await pcsc.listReaders()).find(isYubiKeyReader);
        if (!reader) return { ok: false, error: 'no-key' };
        card = await pcsc.connect(reader, { shared: true });
        await card.beginTransaction();
        inTransaction = true;
        const session = new OathSession(card);
        const selected = await session.select();
        if (selected.challenge) {
            if (password === null) return { ok: false, error: 'locked' };
            await session.validate(selected, password);
        }
        return { ok: true, value: await fn(session, selected) };
    } catch (error) {
        return mapError(error, calculating);
    } finally {
        if (card) {
            if (inTransaction) await card.endTransaction().catch(() => undefined);
            await card.disconnect().catch(() => undefined);
        }
    }
}

async function withCard<T>(
    password: string | null,
    fn: (session: OathSession, selected: Selected) => Promise<T>,
    { retry = true, calculating = false } = {},
): Promise<OathResult<T>> {
    return serialize(async () => {
        const first = await withApplet(password, calculating, fn);
        if (!retry || first.ok || first.error !== 'in-use') return first;
        await new Promise(resolve => setTimeout(resolve, CONTENTION_RETRY_MS));
        return withApplet(password, calculating, fn);
    });
}

// ---- the operations ipc.ts exposes ----

// Reader names of the connected YubiKeys. Operations use the first one
export async function listKeys(): Promise<OathResult<string[]>> {
    if (!pcsc.isLoaded()) return { ok: false, error: 'unavailable' };
    try {
        return { ok: true, value: (await pcsc.listReaders()).filter(isYubiKeyReader) };
    } catch (error) {
        return mapError(error, false);
    }
}

// One LIST and one CALCULATE ALL, then a CALCULATE for each TOTP credential
// whose period is not the default, since CALCULATE ALL has one time step
export async function readAccounts(_serial: number | null, password: string | null): Promise<OathResult<OathAccount[]>> {
    return withCard(password, async (session) => {
        const listed = await session.list();
        if (listed.length === 0) return [];
        const calculated = await session.calculateAll();
        const accounts: OathAccount[] = [];
        for (const { id, type } of listed) {
            const { issuer, name, period } = splitId(id);
            const result = calculated.get(id) ?? { code: null, touch: false };
            let code = type === 'TOTP' ? result.code : null;
            if (type === 'TOTP' && period !== DEFAULT_PERIOD && !result.touch) {
                code = await session.calculate(id, type, period);
            }
            accounts.push({ id, issuer, name, type, period, code, requiresTouch: result.touch });
        }
        return accounts;
    });
}

// Not retried: the key may already have advanced an HOTP counter before the
// failure, and a second attempt would advance it again, leaving the vault
// two behind the service rather than one
export async function calculateCode(_serial: number | null, id: string, password: string | null): Promise<OathResult<string>> {
    return withCard(password, async (session) => {
        const { period } = splitId(id);
        const type = (await session.list()).find(c => c.id === id)?.type;
        if (!type) throw new ApduError(SW.NO_SUCH_OBJECT);
        return session.calculate(id, type, period);
    }, { retry: false, calculating: true });
}

// The one write. The vault keeps the secret; see the header
export async function pushAccount(
    _serial: number | null,
    request: PushRequest,
    secret: string,
    password: string | null,
): Promise<OathResult<true>> {
    // The write path checks its input in full rather than trusting the IPC
    // caller's shape
    const malformed = typeof request !== 'object' || request === null
        || typeof request.name !== 'string'
        || (request.issuer !== null && typeof request.issuer !== 'string')
        || (request.type !== 'TOTP' && request.type !== 'HOTP')
        || typeof request.algorithm !== 'string'
        || !Number.isInteger(request.digits) || !Number.isInteger(request.period) || !Number.isInteger(request.counter)
        || request.period <= 0 || request.counter < 0
        || typeof request.requireTouch !== 'boolean'
        || typeof secret !== 'string';
    if (malformed) return { ok: false, error: 'failed', detail: 'malformed request' };

    const algorithm = request.algorithm.replace('-', '').toLowerCase() as HashName;
    if (!(algorithm in ALGORITHM_BYTE)) return { ok: false, error: 'failed', detail: `unsupported algorithm ${request.algorithm}` };
    if (request.digits < 6 || request.digits > 8) return { ok: false, error: 'failed', detail: `unsupported digit count ${request.digits}` };

    const id = formatId(request.issuer, request.name, request.type, request.period);
    if (utf8(id).length > MAX_ID_BYTES) return { ok: false, error: 'failed', detail: 'name too long for the key' };
    // A default-period id carries no period prefix, so a name that itself
    // starts with `<digits>/` would be read back as one and every code for it
    // computed with the wrong period
    if (request.type === 'TOTP' && request.period === DEFAULT_PERIOD && /^\d+\//.test(id)) {
        return { ok: false, error: 'failed', detail: 'name would be read back as a period' };
    }

    let key: Uint8Array;
    try {
        const decoded = base32Decode(secret);
        key = prepareKey(decoded, algorithm);
        if (key !== decoded) decoded.fill(0);
    } catch {
        return { ok: false, error: 'failed', detail: 'secret is not base32' };
    }

    try {
        return await withCard(password, async (session) => {
            await session.put(id, request.type, algorithm, request.digits, key, request.requireTouch, request.counter);
            return true as const;
        });
    } finally {
        // The vault keeps the secret; this copy has done its job
        key.fill(0);
    }
}

// Whether to offer OATH actions in the UI. A Yubico device on the HID bus is
// the cheap signal; a YubiKey reader on PC/SC is the complete one, and it is
// the only one that sees a key with OTP and FIDO disabled
export async function oathWorthOffering(devicePresent: boolean): Promise<boolean> {
    if (devicePresent) return true;
    const keys = await listKeys();
    return keys.ok && (keys.value?.length ?? 0) > 0;
}

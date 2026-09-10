import * as kdbxweb from 'kdbxweb';
import { CustomField, Entry } from '../types/database';
import { buildPage, FRAGMENT_BLOB, INLINE_BLOB } from './sharePage';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { PasskeyService } from './PasskeyService';
import { SshAgentService, KEEAGENT_SETTINGS_ATTACHMENT } from './SshAgentService';
import { TotpService } from './TotpService';

// Sharing one entry as a single .html file the recipient opens with nothing
// installed. The file holds ciphertext and nothing else: what opens it travels
// by other routes, and in approved mode part of it never leaves this machine.
//
// Two modes:
//   offline   the recipient needs a passphrase you told them. Opens forever.
//   approved  the file is inert until you hand over a code. Codes are derived
//             per time window from a secret kept on the entry, so nothing is
//             stored per open, and when the window table runs out no code
//             opens that file again, including yours.
//
// The generated page is constrained by what a file:// document can do, which
// was measured rather than assumed: crypto.subtle is available and the context
// is secure in both engines, ES modules never execute, and nothing may be
// fetched. So the shell is one classic inline script with every byte embedded.

export interface ShareSchedule {
    // Aligned to the window grid, so both sides agree which window it is
    start: number;
    windowMs: number;
    count: number;
    codeLength: number;
    hasPhrase: boolean;
}

export interface ActiveShare {
    id: string;
    secret: string;
    // Empty when the code carries the whole secret
    phrase: string;
    schedule: ShareSchedule | null;
    recipient: string;
    createdAt: string;
}

// One thing on the entry that can go into the file. `id` is what the dialog
// ticks and what create() is handed back
export interface SharePart {
    id: string;
    label: string;
    kind: 'text' | 'secret' | 'otp' | 'file';
    // Shown beside the label: a file's size, a hint at what the value is
    detail?: string;
    bytes?: number;
}

export interface ShareOptions {
    // Part ids to put in the file. Everything else on the entry stays behind
    include: string[];
    recipient: string;
    senderName: string;
    message: string;
}

const PBKDF2_ITERATIONS = 600_000;
// 15 Crockford characters is 75 bits. The code is the only secret in the file,
// and an attacker holding the file guesses offline, but 2^75 unwrap attempts is
// out of reach by a wide margin at any rate hardware reaches. Short enough to
// read out is worth more here than the digits beyond that
const CODE_LENGTH = 15;
// One code, good for a day, and then the share is over. Shares get opened once
// and the contents put somewhere else, so nothing here needs to outlive that,
// and one window is what keeps a link short enough to send
const SHARE_MS = 24 * 60 * 60 * 1000;
// No I, L, O or U, so a code can be read aloud without the listener having to
// ask which letter it was
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Where the hosted page lives. A link is only ever the convenience: the file
// keeps working when this does not
const SHARE_PAGE_URL = 'https://earu.github.io/Vigil/share/';
// How long a link may get before a file is sent instead. Browsers take far
// more (Chrome's omnibox around 32k) and so do the chat apps, but plain-text
// email folds at 78 characters and some clients break a long URL doing it.
// Checked against the link that was actually built, never a guess at one
const LINK_BUDGET = 16_000;

// Every share on an entry lives in one protected field as JSON: a share is
// five values that only mean anything together, and one field per value times
// one set per recipient turns an entry into a wall of keys
const FIELD_KEY = 'VIGIL_SHARES';

// What a single share used to be written as. Read so that shares made before
// an entry could hold more than one keep working; never written again
const LEGACY_FIELD_KEYS = {
    secret: 'VIGIL_SHARE_SECRET',
    phrase: 'VIGIL_SHARE_PHRASE',
    schedule: 'VIGIL_SHARE_SCHEDULE',
    recipient: 'VIGIL_SHARE_RECIPIENT',
    createdAt: 'VIGIL_SHARE_CREATED',
} as const;

const text = (value: string | kdbxweb.ProtectedValue | undefined): string => {
    if (value === undefined) return '';
    return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
};

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
};

const encodeCrockford = (bytes: Uint8Array): string => {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
};



export class SecretShareService {
    static readonly FIELD_KEY = FIELD_KEY;
    static readonly LEGACY_FIELD_KEYS = LEGACY_FIELD_KEYS;
    static readonly CODE_LENGTH = CODE_LENGTH;
    static readonly SHARE_MS = SHARE_MS;
    static readonly SHARE_PAGE_URL = SHARE_PAGE_URL;
    static readonly LINK_BUDGET = LINK_BUDGET;

    static isShareFieldKey(key: string): boolean {
        return key === FIELD_KEY || (Object.values(LEGACY_FIELD_KEYS) as string[]).includes(key);
    }

    static withoutShareFields(fields: CustomField[]): CustomField[] {
        return fields.filter(field => !this.isShareFieldKey(field.key));
    }

    private static scheduleFrom(raw: unknown): ShareSchedule | null {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof parsed?.start !== 'number' || typeof parsed?.windowMs !== 'number'
            || typeof parsed?.count !== 'number' || parsed.windowMs <= 0 || parsed.count <= 0) {
            return null;
        }
        return {
            start: parsed.start,
            windowMs: parsed.windowMs,
            count: parsed.count,
            codeLength: typeof parsed.codeLength === 'number' ? parsed.codeLength : CODE_LENGTH,
            hasPhrase: parsed.hasPhrase !== false,
        };
    }

    // Every share the entry carries, oldest first. A record with no secret is
    // not a share: the codes cannot be made without it
    static sharesFromFields(fields: CustomField[]): ActiveShare[] {
        const find = (key: string) => fields.find(field => field.key === key);
        const shares: ActiveShare[] = [];

        const raw = text(find(FIELD_KEY)?.value);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                for (const record of Array.isArray(parsed) ? parsed : []) {
                    // A passphrase-only share has no code secret, which is the
                    // whole point of it: it opens forever and there is nothing
                    // to hand out. Either half is enough to be a share
                    const secret = typeof record?.secret === 'string' ? record.secret : '';
                    const phrase = typeof record?.phrase === 'string' ? record.phrase : '';
                    if (!secret && !phrase) continue;
                    shares.push({
                        id: typeof record.id === 'string' && record.id ? record.id : crypto.randomUUID(),
                        secret,
                        phrase,
                        schedule: record.schedule ? this.scheduleFrom(record.schedule) : null,
                        recipient: typeof record.recipient === 'string' ? record.recipient : '',
                        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
                    });
                }
            } catch {
                // Written by something else, or damaged. The entry still
                // opens; only the sharing list is missing
            }
        }

        const legacySecret = text(find(LEGACY_FIELD_KEYS.secret)?.value);
        if (legacySecret) {
            let schedule: ShareSchedule | null = null;
            const legacySchedule = text(find(LEGACY_FIELD_KEYS.schedule)?.value);
            if (legacySchedule) {
                try {
                    schedule = this.scheduleFrom(legacySchedule);
                } catch {
                    schedule = null;
                }
            }
            shares.push({
                id: crypto.randomUUID(),
                secret: legacySecret,
                phrase: text(find(LEGACY_FIELD_KEYS.phrase)?.value),
                schedule,
                recipient: text(find(LEGACY_FIELD_KEYS.recipient)?.value),
                createdAt: text(find(LEGACY_FIELD_KEYS.createdAt)?.value),
            });
        }

        return shares;
    }

    // One field for the lot, protected: it holds the secrets the codes come
    // from. An entry with no shares left carries no field at all
    static toFields(shares: ActiveShare[]): CustomField[] {
        if (shares.length === 0) return [];
        return [{
            key: FIELD_KEY,
            value: kdbxweb.ProtectedValue.fromString(JSON.stringify(shares)),
            protected: true,
        }];
    }

    static windowIndexAt(schedule: ShareSchedule, at: number): number {
        return Math.floor((at - schedule.start) / schedule.windowMs);
    }

    static expiresAt(schedule: ShareSchedule): Date {
        return new Date(schedule.start + schedule.count * schedule.windowMs);
    }

    static windowEndsAt(schedule: ShareSchedule, index: number): Date {
        return new Date(schedule.start + (index + 1) * schedule.windowMs);
    }

    // The code characters themselves are the key material, not the bytes
    // behind them: both sides feed the canonical string into the KDF, so
    // there is no second encoding to get wrong
    static async codeFor(secret: string, index: number, length: number): Promise<string> {
        const key = await crypto.subtle.importKey('raw', fromBase64(secret) as BufferSource, 'HKDF', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(`code:${index}`) }, key, 160);
        return encodeCrockford(new Uint8Array(bits)).slice(0, length);
    }

    // Groups of five after the three-character window index, so a code reads
    // aloud as four short chunks
    static formatCode(index: number, code: string): string {
        let head = '';
        for (let shift = 10; shift >= 0; shift -= 5) head += ALPHABET[(index >>> shift) & 31];
        return [head, ...(code.match(/.{1,5}/g) ?? [])].join('-');
    }

    static async currentCode(share: ActiveShare, at: number = Date.now()):
        Promise<{ code: string; index: number; endsAt: Date } | null> {
        if (!share.schedule) return null;
        const index = this.windowIndexAt(share.schedule, at);
        if (index < 0 || index >= share.schedule.count) return null;
        const code = await this.codeFor(share.secret, index, share.schedule.codeLength);
        return {
            code: this.formatCode(index, code),
            index,
            endsAt: this.windowEndsAt(share.schedule, index),
        };
    }

    private static async phraseKey(phrase: string, salt: Uint8Array): Promise<Uint8Array> {
        const key = await crypto.subtle.importKey('raw', utf8(phrase) as BufferSource, 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
        return new Uint8Array(bits);
    }

    // One wrap of the file key per window. The IV comes out of the same HKDF
    // as the key, so only the ciphertext and tag are stored
    private static async wrapKey(
        phraseKey: Uint8Array, code: string, salt: Uint8Array, fileKey: Uint8Array
    ): Promise<Uint8Array> {
        const hk = await crypto.subtle.importKey('raw', concat(phraseKey, utf8(code)) as BufferSource, 'HKDF', false, ['deriveBits']);
        const derived = new Uint8Array(await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8('vigil-share-wrap-v1') }, hk, 352));
        const key = await crypto.subtle.importKey('raw', derived.slice(0, 32) as BufferSource, 'AES-GCM', false, ['encrypt']);
        const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: derived.slice(32, 44) }, key, fileKey as BufferSource);
        return new Uint8Array(sealed);
    }

    private static async cspHash(value: string): Promise<string> {
        const digest = await crypto.subtle.digest('SHA-256', utf8(value) as BufferSource);
        return `sha256-${toBase64(new Uint8Array(digest))}`;
    }

    static fileNameFor(entry: Entry): string {
        const stem = (entry.title || 'password').replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 48);
        return `${stem || 'password'} (shared).html`;
    }

    // Everything the recipient sees. Kept to a fixed set of fields so the
    // page can render it without ever treating a value as markup
    // Everything on this entry that can be shared, in the order it is shown.
    // Empty values are left out: a checkbox for a field with nothing in it is
    // only a way to send an empty box
    static partsOf(entry: Entry): SharePart[] {
        const parts: SharePart[] = [];
        const add = (id: string, label: string, kind: SharePart['kind'], value: string, detail?: string) => {
            if (value) parts.push({ id, label, kind, detail, bytes: utf8(value).length });
        };

        add('title', 'Site', 'text', entry.title ?? '');
        add('username', 'Username', 'text', entry.username ?? '');
        add('password', 'Password', 'secret', text(entry.password));
        add('url', 'Web address', 'text', entry.url ?? '');
        add('notes', 'Notes', 'text', entry.notes ?? '');

        const otp = TotpService.getConfig(entry.customFields ?? []);
        if (otp) {
            parts.push({
                id: 'otp',
                label: 'One-time code',
                kind: 'otp',
                detail: otp.type === 'totp' ? 'a live code, refreshed like yours' : 'counter-based, one code at a time',
                bytes: 120,
            });
        }

        for (const field of entry.customFields ?? []) {
            if (this.isShareFieldKey(field.key) || TotpService.isTotpKey(field.key)) continue;
            if (PasskeyService.isPasskeyFieldKey(field.key)) continue;
            const value = text(field.value);
            if (!value) continue;
            parts.push({
                id: `field:${field.key}`,
                label: field.key,
                kind: field.protected ? 'secret' : 'text',
                bytes: utf8(value).length,
            });
        }

        // An SSH key is an attachment like any other, and worth saying so:
        // sharing one hands over the key itself, not a reference to it. The
        // KeeAgent settings file is configuration rather than content
        const sshKeys = new Set(SshAgentService.keyCandidates(entry).map(key => key.name));
        for (const attachment of entry.attachments ?? []) {
            if (attachment.name === KEEAGENT_SETTINGS_ATTACHMENT) continue;
            const bytes = attachment.data.byteLength;
            parts.push({
                id: `file:${attachment.name}`,
                label: attachment.name,
                kind: 'file',
                detail: sshKeys.has(attachment.name) ? `SSH key, ${this.formatSize(bytes)}` : this.formatSize(bytes),
                bytes,
            });
        }

        return parts;
    }

    // What a share starts ticked with: the login itself. Notes, one-time
    // codes, custom fields and files are all deliberate additions, because
    // each one hands over something the recipient did not have to have
    static defaultSelection(parts: SharePart[]): string[] {
        const wanted = new Set(['title', 'username', 'password', 'url']);
        return parts.filter(part => wanted.has(part.id)).map(part => part.id);
    }

    // The blob rides in the fragment, which browsers never send to the server,
    // so the page's host sees a visit and never the share
    static linkFor(blobJson: string): string {
        const base64 = toBase64(utf8(blobJson));
        return `${SHARE_PAGE_URL}#${base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    }

    static formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // Only what was ticked, as a flat list the page renders without knowing
    // what any of it means
    private static payloadOf(entry: Entry, options: ShareOptions) {
        const wanted = new Set(options.include);
        const items: Array<Record<string, unknown>> = [];
        const push = (id: string, label: string, kind: string, value: string) => {
            if (wanted.has(id) && value) items.push({ kind, label, value });
        };

        push('title', 'Site', 'text', entry.title ?? '');
        push('username', 'Username', 'text', entry.username ?? '');
        push('password', 'Password', 'secret', text(entry.password));
        push('url', 'Web address', 'text', entry.url ?? '');
        push('notes', 'Notes', 'text', entry.notes ?? '');

        if (wanted.has('otp')) {
            const otp = TotpService.getConfig(entry.customFields ?? []);
            if (otp) {
                // A counter-based code is handed over at the counter the vault
                // is on. Codes the recipient takes from here do not move the
                // vault's own counter, which is the same drift two people
                // sharing an HOTP secret always have
                items.push(otp.type === 'totp'
                    ? {
                        kind: 'otp', type: 'totp', label: 'One-time code', secret: otp.secret,
                        digits: otp.digits, period: otp.period, algorithm: otp.algorithm, encoder: otp.encoder,
                    }
                    : {
                        kind: 'otp', type: 'hotp', label: 'One-time code', secret: otp.secret,
                        digits: otp.digits, counter: otp.counter, algorithm: otp.algorithm, encoder: otp.encoder,
                    });
            }
        }

        for (const field of entry.customFields ?? []) {
            const id = `field:${field.key}`;
            if (!wanted.has(id)) continue;
            push(id, field.key, field.protected ? 'secret' : 'text', text(field.value));
        }

        for (const attachment of entry.attachments ?? []) {
            if (!wanted.has(`file:${attachment.name}`)) continue;
            const bytes = KeepassDatabaseService.getAttachmentBytes(attachment);
            items.push({
                kind: 'file', label: attachment.name,
                size: this.formatSize(bytes.byteLength), data: toBase64(bytes),
            });
        }

        return {
            v: 2,
            items,
            message: options.message ?? '',
            sharedAt: new Date().toISOString(),
        };
    }

    static async create(entry: Entry, options: ShareOptions): Promise<{ html: Uint8Array; link: string; share: ActiveShare }> {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        // Nothing but the code opens a share, so the passphrase half of the
        // key derivation is a constant. It stays in the derivation because the
        // files already out there were made with it
        const phraseKey = await this.phraseKey('', salt);
        const fileKey = crypto.getRandomValues(new Uint8Array(32));
        const aes = await crypto.subtle.importKey('raw', fileKey as BufferSource, 'AES-GCM', false, ['encrypt']);
        const sealed = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv as BufferSource }, aes, utf8(JSON.stringify(this.payloadOf(entry, options)))));

        const blob: Record<string, unknown> = {
            sender: options.senderName || '',
            mode: 'approved',
            iterations: PBKDF2_ITERATIONS,
            salt: toBase64(salt),
            iv: toBase64(iv),
            data: toBase64(sealed),
        };

        const share: ActiveShare = {
            id: crypto.randomUUID(),
            secret: '',
            phrase: '',
            schedule: null,
            recipient: options.recipient,
            createdAt: new Date().toISOString(),
        };

        {
            // Counted from now, not from a grid: with one window an aligned
            // start would give an evening share an hour of life
            const schedule: ShareSchedule = {
                start: Date.now(),
                windowMs: SHARE_MS,
                count: 1,
                codeLength: CODE_LENGTH,
                hasPhrase: false,
            };
            const secret = crypto.getRandomValues(new Uint8Array(32));
            share.secret = toBase64(secret);
            share.schedule = schedule;

            const wraps: string[] = [];
            for (let index = 0; index < schedule.count; index++) {
                const code = await this.codeFor(share.secret, index, schedule.codeLength);
                wraps.push(toBase64(await this.wrapKey(phraseKey, code, salt, fileKey)));
            }
            blob.wraps = wraps;
            blob.start = schedule.start;
            blob.windowMs = schedule.windowMs;
            blob.codeLength = schedule.codeLength;
        }

        const json = JSON.stringify(blob);
        const html = await buildPage(INLINE_BLOB(json), text => this.cspHash(text));
        return { html: utf8(html), link: this.linkFor(json), share };
    }

    // The hosted page, built from the same source as the file. Only where the
    // blob comes from differs
    static hostedPage(digest: (text: string) => Promise<string>): Promise<string> {
        return buildPage(FRAGMENT_BLOB, digest);
    }
}

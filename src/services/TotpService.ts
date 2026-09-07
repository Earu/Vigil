import * as kdbxweb from 'kdbxweb';
import { CustomField } from '../types/database';

interface OtpConfigBase {
    secret: string; // normalized base32, no padding or separators
    digits: number;
    algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
    // How the truncated HMAC becomes the code the user reads. Absent is the
    // RFC 4226 decimal one; 'steam' is Steam Guard's five-character base-26
    // alphabet. Optional rather than a required union so a config built
    // without thinking about it is the ordinary kind, which is the safe way
    // round to be wrong
    encoder?: 'steam';
}

export interface TotpConfig extends OtpConfigBase {
    type: 'totp';
    period: number;
}

// Counter-based (RFC 4226): the counter is the next value to use, and every
// generated code advances it in the entry
export interface HotpConfig extends OtpConfigBase {
    type: 'hotp';
    counter: number;
}

export type OtpConfig = TotpConfig | HotpConfig;

// One account from a Google Authenticator export QR
export interface MigrationAccount {
    name: string;
    issuer: string;
    config: OtpConfig;
}

// Where a config was read from, so a counter update lands in the same
// convention rather than converting the entry
type OtpSource = 'otp' | 'keepass-totp' | 'keepass-hotp' | 'keetray';

interface ReadConfig {
    config: OtpConfig;
    source: OtpSource;
    // The field holding the secret (or the URI), so its key spelling and
    // protection survive a rewrite
    field: CustomField;
}

// Field names used by the various OTP storage conventions. All of them are
// managed through the dedicated OTP UI and hidden from the custom field list
// whenever they parse.
const OTP_FIELD = 'otp';
const KEEPASS_FIELDS = ['TimeOtp-Secret-Base32', 'TimeOtp-Length', 'TimeOtp-Period', 'TimeOtp-Algorithm'];
// KeePass 2.47 {HMACOTP}: fixed at 6 digits, SHA-1
const KEEPASS_HOTP_FIELDS = ['HmacOtp-Secret-Base32', 'HmacOtp-Counter'];
const KEETRAY_FIELDS = ['TOTP Seed', 'TOTP Settings'];

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Steam Guard. Ordinary TOTP (HMAC-SHA1, 30 second step, RFC 4226 dynamic
// truncation) up to the last step, where the 31 bit value becomes five
// characters of this alphabet instead of decimal digits. Nothing else about
// it varies, so a URI claiming other digits, another algorithm or another
// period is contradicting itself and those values are not read from it.
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const STEAM_DIGITS = 5;
const STEAM_PERIOD = 30;

export class TotpService {
    static readonly TOTP_KEYS = [OTP_FIELD, ...KEEPASS_FIELDS, ...KEEPASS_HOTP_FIELDS, ...KEETRAY_FIELDS];

    static isTotpKey(key: string): boolean {
        return this.TOTP_KEYS.some(k => k.toLowerCase() === key.toLowerCase());
    }

    private static fieldString(value: string | kdbxweb.ProtectedValue): string {
        return typeof value === 'string' ? value : value.getText();
    }

    static normalizeSecret(secret: string): string | null {
        const cleaned = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
        // One base32 character is five bits, which decodes to no key at all,
        // and an empty HMAC key is refused by WebCrypto at code time rather
        // than here. Two characters is the shortest thing that is a key
        if (cleaned.length < 2) return null;
        if (![...cleaned].every(c => BASE32_ALPHABET.includes(c))) return null;
        return cleaned;
    }

    static steamConfig(secret: string): TotpConfig {
        return { type: 'totp', secret, period: STEAM_PERIOD, digits: STEAM_DIGITS, algorithm: 'SHA-1', encoder: 'steam' };
    }

    static isSteam(config: OtpConfig | null | undefined): boolean {
        return config?.encoder === 'steam';
    }

    // The secret behind a steam:// input. A Steam authenticator tool writes a
    // maFile holding both spellings: `shared_secret` is base64 and the `uri`
    // field's secret is base32, and people paste whichever they found.
    //
    // Only the format decides, never the content: a 20 byte secret is 32
    // base32 characters, or 27 of base64 plus exactly one '=' of padding.
    // So '+', '/' and '=' are each impossible in the base32 form and settle
    // it, and a real maFile secret always carries the padding. Anything with
    // none of them is read as base32, which is the documented steam:// form.
    // Guessing on likelihood instead would silently derive the wrong key
    private static steamSecret(raw: string): string | null {
        const cleaned = raw.replace(/\s/g, '');
        if (!/[+/=]/.test(cleaned)) return this.normalizeSecret(cleaned);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
        try {
            const bytes = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
            return bytes.length > 0 ? this.base32Encode(bytes) : null;
        } catch {
            return null;
        }
    }

    private static sanitizeCounter(raw: string | undefined): number {
        const counter = parseInt(raw ?? '0', 10);
        return Number.isSafeInteger(counter) && counter >= 0 ? counter : 0;
    }

    private static sanitizeDigits(raw: string | undefined): number {
        const digits = parseInt(raw ?? '6', 10);
        return Number.isFinite(digits) && digits >= 6 && digits <= 8 ? digits : 6;
    }

    private static sanitizePeriod(raw: string | undefined): number {
        const period = parseInt(raw ?? '30', 10);
        return Number.isFinite(period) && period > 0 ? period : 30;
    }

    static parseOtpAuthUri(uri: string): OtpConfig | null {
        // Parsed by hand: Chromium's URL treats non-special schemes as opaque
        // paths (host comes back empty), unlike Node, so new URL() is unusable
        // The label is captured too: it is one of the places a URI says it is
        // a Steam secret (see steamFromUri)
        const match = uri.trim().match(/^otpauth:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
        if (!match) return null;
        const host = match[1].toLowerCase();
        if (host !== 'totp' && host !== 'hotp' && host !== 'steam') return null;

        const params = new URLSearchParams(match[3] ?? '');
        const secret = this.normalizeSecret(params.get('secret') ?? '');
        if (!secret) return null;

        const algoParam = (params.get('algorithm') ?? 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const algorithm = algoParam === 'SHA256' ? 'SHA-256' : algoParam === 'SHA512' ? 'SHA-512' : 'SHA-1';
        const digits = this.sanitizeDigits(params.get('digits') ?? undefined);

        // Counter-based Steam does not exist, so the hotp host settles it
        // before any of the Steam signals are consulted
        if (host === 'hotp') {
            return { type: 'hotp', secret, digits, algorithm, counter: this.sanitizeCounter(params.get('counter') ?? undefined) };
        }
        if (this.steamFromUri(host, match[2], params)) return this.steamConfig(secret);
        return { type: 'totp', secret, digits, algorithm, period: this.sanitizePeriod(params.get('period') ?? undefined) };
    }

    // Whether an otpauth URI is a Steam one. Four signals, because no single
    // spelling is standard:
    //
    //   otpauth://steam/...            some extractors
    //   ...&encoder=steam              KeePassXC and Aegis exports
    //   ...&issuer=Steam               the maFile's own `uri` field
    //   otpauth://totp/Steam:user?...  the same URI's label
    //
    // The last two are inference rather than a declaration, and they are here
    // because the URI a Steam tool actually writes carries no encoder at all:
    // read literally it is an ordinary TOTP URI and yields six digits that
    // Steam rejects. Guessing is safe in this one direction because Steam
    // has exactly one OTP scheme, so an issuer of Steam cannot mean anything
    // else. The entry panel names the result, and removing it is one click
    private static steamFromUri(host: string, path: string, params: URLSearchParams): boolean {
        if (host === 'steam') return true;
        if ((params.get('encoder') ?? '').toLowerCase() === 'steam') return true;
        if ((params.get('issuer') ?? '').trim().toLowerCase() === 'steam') return true;
        let label = path;
        try {
            label = decodeURIComponent(path);
        } catch { /* keep the raw form; a bad escape is not a Steam label */ }
        return /^\/?steam:/i.test(label);
    }

    // Google Authenticator "Transfer accounts" QR:
    // otpauth-migration://offline?data=<base64 protobuf batch of accounts>.
    // The protobuf schema is tiny and stable, so it is decoded by hand:
    //   MigrationPayload { repeated OtpParameters otp_parameters = 1; ... }
    //   OtpParameters { bytes secret = 1; string name = 2; string issuer = 3;
    //                   Algorithm algorithm = 4; DigitCount digits = 5;
    //                   OtpType type = 6; int64 counter = 7; }
    static parseMigrationUri(uri: string): MigrationAccount[] | null {
        const match = uri.trim().match(/^otpauth-migration:\/\/offline\?([^#]*)/i);
        if (!match) return null;
        const dataMatch = match[1].match(/(?:^|&)data=([^&]*)/);
        if (!dataMatch) return null;

        let payload: Uint8Array;
        try {
            // decodeURIComponent instead of URLSearchParams: the latter turns
            // the base64 '+' into a space
            payload = Uint8Array.from(atob(decodeURIComponent(dataMatch[1])), c => c.charCodeAt(0));
        } catch {
            return null;
        }

        try {
            const accounts: MigrationAccount[] = [];
            for (const field of this.protoFields(payload)) {
                if (field.field !== 1 || !(field.value instanceof Uint8Array)) continue;
                const account = this.parseOtpParameters(field.value);
                if (account) accounts.push(account);
            }
            return accounts;
        } catch {
            return null;
        }
    }

    private static parseOtpParameters(bytes: Uint8Array): MigrationAccount | null {
        let secret: Uint8Array | null = null;
        let name = '';
        let issuer = '';
        let algorithm = 0;
        let digits = 0;
        let type = 0;
        let counter = 0;

        const text = new TextDecoder();
        for (const field of this.protoFields(bytes)) {
            if (field.value instanceof Uint8Array) {
                if (field.field === 1) secret = field.value;
                else if (field.field === 2) name = text.decode(field.value);
                else if (field.field === 3) issuer = text.decode(field.value);
            } else {
                if (field.field === 4) algorithm = field.value;
                else if (field.field === 5) digits = field.value;
                else if (field.field === 6) type = field.value;
                else if (field.field === 7) counter = field.value;
            }
        }

        if (!secret || secret.length === 0) return null;

        const base = {
            secret: this.base32Encode(secret),
            digits: digits === 2 ? 8 : 6,
            algorithm: algorithm === 2 ? 'SHA-256' : algorithm === 3 ? 'SHA-512' : 'SHA-1',
        } as const;
        // type 1 is HOTP; 0 (unspecified) is treated as TOTP
        const config: OtpConfig = type === 1
            ? { type: 'hotp', ...base, counter: Number.isSafeInteger(counter) ? counter : 0 }
            : { type: 'totp', ...base, period: 30 }; // the schema has no period field

        return { name, issuer, config };
    }

    // Minimal protobuf wire-format reader: varints and length-delimited
    // fields, which is all the migration payload uses
    private static protoFields(bytes: Uint8Array): { field: number; value: number | Uint8Array }[] {
        const fields: { field: number; value: number | Uint8Array }[] = [];
        let pos = 0;
        const varint = (): number => {
            let result = 0;
            let shift = 0;
            while (pos < bytes.length) {
                const byte = bytes[pos++];
                // multiply instead of shifting: shifts wrap at 32 bits
                result += (byte & 0x7f) * 2 ** shift;
                if ((byte & 0x80) === 0) return result;
                shift += 7;
            }
            throw new Error('truncated varint');
        };
        while (pos < bytes.length) {
            const tag = varint();
            const fieldNo = Math.floor(tag / 8);
            const wireType = tag & 7;
            if (wireType === 0) {
                fields.push({ field: fieldNo, value: varint() });
            } else if (wireType === 2) {
                const length = varint();
                if (pos + length > bytes.length) throw new Error('truncated field');
                fields.push({ field: fieldNo, value: bytes.subarray(pos, pos + length) });
                pos += length;
            } else if (wireType === 5) {
                pos += 4;
            } else if (wireType === 1) {
                pos += 8;
            } else {
                throw new Error('unsupported wire type');
            }
        }
        return fields;
    }

    // Accepts an otpauth:// URI, Bitwarden's steam://<secret>, or a bare
    // base32 secret (always time-based)
    static parseUserInput(input: string): OtpConfig | null {
        const trimmed = input.trim();
        if (trimmed.toLowerCase().startsWith('otpauth://')) {
            return this.parseOtpAuthUri(trimmed);
        }
        // The one marker a user can produce by hand. Nothing a Steam tool
        // writes says "steam" on its own, so without this the only way to
        // enter one is to already hold an export from another manager
        if (trimmed.toLowerCase().startsWith('steam://')) {
            const secret = this.steamSecret(trimmed.slice('steam://'.length));
            return secret ? this.steamConfig(secret) : null;
        }
        const secret = this.normalizeSecret(trimmed);
        if (!secret) return null;
        return { type: 'totp', secret, period: 30, digits: 6, algorithm: 'SHA-1' };
    }

    static buildOtpAuthUri(config: OtpConfig, label: string): string {
        const params = new URLSearchParams();
        params.set('secret', config.secret);
        if (config.type === 'totp') params.set('period', String(config.period));
        else params.set('counter', String(config.counter));
        params.set('digits', String(config.digits));
        params.set('algorithm', config.algorithm.replace('-', ''));
        // Without this a Steam entry exported to CSV and imported back is an
        // ordinary six digit one, which is the silent failure this whole
        // encoder exists to stop. Same spelling KeePassXC writes
        if (config.encoder === 'steam') params.set('encoder', 'steam');
        return `otpauth://${config.type}/${encodeURIComponent(label || 'Vigil')}?${params.toString()}`;
    }

    static getConfig(customFields: CustomField[]): OtpConfig | null {
        return this.readConfig(customFields)?.config ?? null;
    }

    // Reads whichever OTP convention the entry uses, in priority order:
    // the KeePassXC/KeeWeb `otp` field, the KeePass 2.47 TimeOtp-* fields,
    // its HmacOtp-* fields, then the KeeTrayTOTP plugin's TOTP Seed / TOTP
    // Settings pair. An entry carrying both KeePass conventions reads as TOTP.
    private static readConfig(customFields: CustomField[]): ReadConfig | null {
        const find = (key: string) => customFields.find(f => f.key.toLowerCase() === key.toLowerCase());
        const get = (key: string) => {
            const field = find(key);
            return field ? this.fieldString(field.value) : undefined;
        };

        const otpField = find(OTP_FIELD);
        if (otpField) {
            const parsed = this.parseUserInput(this.fieldString(otpField.value));
            if (parsed) return { config: parsed, source: 'otp', field: otpField };
        }

        const kpField = find('TimeOtp-Secret-Base32');
        const kpSecret = kpField && this.normalizeSecret(this.fieldString(kpField.value));
        if (kpField && kpSecret) {
            const algoRaw = (get('TimeOtp-Algorithm') ?? '').toUpperCase();
            const algorithm = algoRaw.includes('256') ? 'SHA-256' : algoRaw.includes('512') ? 'SHA-512' : 'SHA-1';
            return {
                config: {
                    type: 'totp',
                    secret: kpSecret,
                    period: this.sanitizePeriod(get('TimeOtp-Period')),
                    digits: this.sanitizeDigits(get('TimeOtp-Length')),
                    algorithm,
                },
                source: 'keepass-totp',
                field: kpField,
            };
        }

        const hmacField = find('HmacOtp-Secret-Base32');
        const hmacSecret = hmacField && this.normalizeSecret(this.fieldString(hmacField.value));
        if (hmacField && hmacSecret) {
            return {
                config: {
                    type: 'hotp',
                    secret: hmacSecret,
                    digits: 6,
                    algorithm: 'SHA-1',
                    counter: this.sanitizeCounter(get('HmacOtp-Counter')),
                },
                source: 'keepass-hotp',
                field: hmacField,
            };
        }

        const seedField = find('TOTP Seed');
        const seed = seedField && this.normalizeSecret(this.fieldString(seedField.value));
        if (seedField && seed) {
            // "30;6" period;digits
            const settings = (get('TOTP Settings') ?? '').split(';');
            // KeeTrayTOTP writes the length where a digit count goes, and 'S'
            // there means Steam. Read as a digit count it is NaN, which used
            // to fall back to 6 and produce a confident, wrong code
            const steam = (settings[1] ?? '').trim().toUpperCase() === 'S';
            return {
                config: steam ? this.steamConfig(seed) : {
                    type: 'totp',
                    secret: seed,
                    period: this.sanitizePeriod(settings[0]),
                    digits: this.sanitizeDigits(settings[1]),
                    algorithm: 'SHA-1',
                },
                source: 'keetray',
                field: seedField,
            };
        }

        return null;
    }

    // The one field whose value moves the HOTP counter, in the convention the
    // entry already uses. null when the entry holds no HOTP config
    static counterField(customFields: CustomField[], counter: number): CustomField | null {
        const read = this.readConfig(customFields);
        if (!read || read.config.type !== 'hotp') return null;

        if (read.source === 'otp') {
            // Only the counter parameter changes: the label and issuer stored
            // in the URI must survive, so this is not a buildOtpAuthUri rebuild
            const uri = this.fieldString(read.field.value).trim();
            const match = uri.match(/^([^?#]*)(?:\?([^#]*))?/)!;
            const params = new URLSearchParams(match[2] ?? '');
            params.set('counter', String(counter));
            return { key: read.field.key, value: `${match[1]}?${params.toString()}`, protected: read.field.protected };
        }

        const existing = customFields.find(f => f.key.toLowerCase() === 'hmacotp-counter');
        return { key: existing?.key ?? 'HmacOtp-Counter', value: String(counter), protected: existing?.protected ?? false };
    }

    // customFields with the counter moved; the same array comes back when
    // there is nothing to write
    static withCounter(customFields: CustomField[], counter: number): CustomField[] {
        const next = this.counterField(customFields, counter);
        if (!next) return customFields;
        const index = customFields.findIndex(f => f.key.toLowerCase() === next.key.toLowerCase());
        return index === -1
            ? [...customFields, next]
            : customFields.map((f, i) => (i === index ? next : f));
    }

    private static base32Encode(bytes: Uint8Array): string {
        let bits = 0;
        let value = 0;
        let out = '';
        for (const byte of bytes) {
            value = (value << 8) | byte;
            bits += 8;
            while (bits >= 5) {
                out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        if (bits > 0) {
            out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
        }
        return out;
    }

    private static base32Decode(secret: string): Uint8Array {
        let bits = 0;
        let value = 0;
        const out: number[] = [];
        for (const char of secret) {
            value = (value << 5) | BASE32_ALPHABET.indexOf(char);
            bits += 5;
            if (bits >= 8) {
                out.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return new Uint8Array(out);
    }

    static async generateCode(config: OtpConfig, nowMs = Date.now()): Promise<string> {
        const counter = config.type === 'hotp' ? config.counter : Math.floor(nowMs / 1000 / config.period);
        const counterBytes = new Uint8Array(8);
        // Full 64-bit big-endian counter, split by division rather than
        // shifts, which wrap at 32 bits (the same trick as protoFields)
        const view = new DataView(counterBytes.buffer);
        view.setUint32(0, Math.floor(counter / 2 ** 32));
        view.setUint32(4, counter >>> 0);

        const key = await crypto.subtle.importKey(
            'raw',
            this.base32Decode(config.secret),
            { name: 'HMAC', hash: config.algorithm },
            false,
            ['sign']
        );
        const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));

        const offset = hmac[hmac.length - 1] & 0x0f;
        const binary =
            ((hmac[offset] & 0x7f) << 24) |
            (hmac[offset + 1] << 16) |
            (hmac[offset + 2] << 8) |
            hmac[offset + 3];

        // Everything above is RFC 4226. Steam differs only here: the same
        // 31 bit value read as five base-26 digits, least significant first
        if (config.encoder === 'steam') {
            let value = binary;
            let code = '';
            for (let i = 0; i < STEAM_DIGITS; i++) {
                code += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
                value = Math.floor(value / STEAM_ALPHABET.length);
            }
            return code;
        }

        return String(binary % 10 ** config.digits).padStart(config.digits, '0');
    }

    static secondsRemaining(config: TotpConfig, nowMs = Date.now()): number {
        const period = config.period * 1000;
        return Math.ceil((period - (nowMs % period)) / 1000);
    }
}

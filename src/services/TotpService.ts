import * as kdbxweb from 'kdbxweb';
import { CustomField } from '../types/database';

interface OtpConfigBase {
    secret: string; // normalized base32, no padding or separators
    digits: number;
    algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
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
        const match = uri.trim().match(/^otpauth:\/\/([^/?#]+)[^?#]*(?:\?([^#]*))?/i);
        if (!match) return null;
        const host = match[1].toLowerCase();
        if (host !== 'totp' && host !== 'hotp') return null;

        const params = new URLSearchParams(match[2] ?? '');
        const secret = this.normalizeSecret(params.get('secret') ?? '');
        if (!secret) return null;

        const algoParam = (params.get('algorithm') ?? 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const algorithm = algoParam === 'SHA256' ? 'SHA-256' : algoParam === 'SHA512' ? 'SHA-512' : 'SHA-1';
        const digits = this.sanitizeDigits(params.get('digits') ?? undefined);

        if (host === 'hotp') {
            return { type: 'hotp', secret, digits, algorithm, counter: this.sanitizeCounter(params.get('counter') ?? undefined) };
        }
        return { type: 'totp', secret, digits, algorithm, period: this.sanitizePeriod(params.get('period') ?? undefined) };
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

    // Accepts an otpauth:// URI or a bare base32 secret (always time-based)
    static parseUserInput(input: string): OtpConfig | null {
        const trimmed = input.trim();
        if (trimmed.toLowerCase().startsWith('otpauth://')) {
            return this.parseOtpAuthUri(trimmed);
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
            return {
                config: {
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

        return String(binary % 10 ** config.digits).padStart(config.digits, '0');
    }

    static secondsRemaining(config: TotpConfig, nowMs = Date.now()): number {
        const period = config.period * 1000;
        return Math.ceil((period - (nowMs % period)) / 1000);
    }
}

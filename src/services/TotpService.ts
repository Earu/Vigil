import * as kdbxweb from 'kdbxweb';
import { CustomField } from '../types/database';

export interface TotpConfig {
    secret: string; // normalized base32, no padding or separators
    period: number;
    digits: number;
    algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

// One account from a Google Authenticator export QR
export interface MigrationAccount {
    name: string;
    issuer: string;
    config: TotpConfig;
}

// Field names used by the various TOTP storage conventions. All of them are
// managed through the dedicated TOTP UI and hidden from the custom field list.
const OTP_FIELD = 'otp';
const KEEPASS_FIELDS = ['TimeOtp-Secret-Base32', 'TimeOtp-Length', 'TimeOtp-Period', 'TimeOtp-Algorithm'];
const KEETRAY_FIELDS = ['TOTP Seed', 'TOTP Settings'];

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class TotpService {
    static readonly TOTP_KEYS = [OTP_FIELD, ...KEEPASS_FIELDS, ...KEETRAY_FIELDS];

    static isTotpKey(key: string): boolean {
        return this.TOTP_KEYS.some(k => k.toLowerCase() === key.toLowerCase());
    }

    private static fieldString(value: string | kdbxweb.ProtectedValue): string {
        return typeof value === 'string' ? value : value.getText();
    }

    static normalizeSecret(secret: string): string | null {
        const cleaned = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
        if (cleaned.length === 0) return null;
        if (![...cleaned].every(c => BASE32_ALPHABET.includes(c))) return null;
        return cleaned;
    }

    static parseOtpAuthUri(uri: string): TotpConfig | null {
        // Parsed by hand: Chromium's URL treats non-special schemes as opaque
        // paths (host comes back empty), unlike Node, so new URL() is unusable
        const match = uri.trim().match(/^otpauth:\/\/([^/?#]+)[^?#]*(?:\?([^#]*))?/i);
        if (!match) return null;
        // otpauth://hotp/... is counter-based and out of scope
        if (match[1].toLowerCase() !== 'totp') return null;

        const params = new URLSearchParams(match[2] ?? '');
        const secret = this.normalizeSecret(params.get('secret') ?? '');
        if (!secret) return null;

        const algoParam = (params.get('algorithm') ?? 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const algorithm = algoParam === 'SHA256' ? 'SHA-256' : algoParam === 'SHA512' ? 'SHA-512' : 'SHA-1';
        const digits = parseInt(params.get('digits') ?? '6', 10);
        const period = parseInt(params.get('period') ?? '30', 10);

        return {
            secret,
            period: Number.isFinite(period) && period > 0 ? period : 30,
            digits: Number.isFinite(digits) && digits >= 6 && digits <= 8 ? digits : 6,
            algorithm,
        };
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
            }
        }

        // type 1 is HOTP (counter-based, out of scope like elsewhere);
        // 0 (unspecified) is treated as TOTP
        if (!secret || secret.length === 0 || type === 1) return null;

        return {
            name,
            issuer,
            config: {
                secret: this.base32Encode(secret),
                period: 30, // the schema has no period field
                digits: digits === 2 ? 8 : 6,
                algorithm: algorithm === 2 ? 'SHA-256' : algorithm === 3 ? 'SHA-512' : 'SHA-1',
            },
        };
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

    // Accepts an otpauth:// URI or a bare base32 secret
    static parseUserInput(input: string): TotpConfig | null {
        const trimmed = input.trim();
        if (trimmed.toLowerCase().startsWith('otpauth://')) {
            return this.parseOtpAuthUri(trimmed);
        }
        const secret = this.normalizeSecret(trimmed);
        if (!secret) return null;
        return { secret, period: 30, digits: 6, algorithm: 'SHA-1' };
    }

    static buildOtpAuthUri(config: TotpConfig, label: string): string {
        const params = new URLSearchParams();
        params.set('secret', config.secret);
        params.set('period', String(config.period));
        params.set('digits', String(config.digits));
        params.set('algorithm', config.algorithm.replace('-', ''));
        return `otpauth://totp/${encodeURIComponent(label || 'Vigil')}?${params.toString()}`;
    }

    // Reads whichever TOTP convention the entry uses, in priority order:
    // the KeePassXC/KeeWeb `otp` field, the KeePass 2.47 TimeOtp-* fields,
    // then the KeeTrayTOTP plugin's TOTP Seed / TOTP Settings pair.
    static getConfig(customFields: CustomField[]): TotpConfig | null {
        const get = (key: string) => {
            const field = customFields.find(f => f.key.toLowerCase() === key.toLowerCase());
            return field ? this.fieldString(field.value) : undefined;
        };

        const otp = get(OTP_FIELD);
        if (otp) {
            const parsed = this.parseUserInput(otp);
            if (parsed) return parsed;
        }

        const kpSecret = get('TimeOtp-Secret-Base32');
        if (kpSecret) {
            const secret = this.normalizeSecret(kpSecret);
            if (secret) {
                const algoRaw = (get('TimeOtp-Algorithm') ?? '').toUpperCase();
                const algorithm = algoRaw.includes('256') ? 'SHA-256' : algoRaw.includes('512') ? 'SHA-512' : 'SHA-1';
                const digits = parseInt(get('TimeOtp-Length') ?? '6', 10);
                const period = parseInt(get('TimeOtp-Period') ?? '30', 10);
                return {
                    secret,
                    period: Number.isFinite(period) && period > 0 ? period : 30,
                    digits: Number.isFinite(digits) && digits >= 6 && digits <= 8 ? digits : 6,
                    algorithm,
                };
            }
        }

        const seed = get('TOTP Seed');
        if (seed) {
            const secret = this.normalizeSecret(seed);
            if (secret) {
                // "30;6" period;digits
                const settings = (get('TOTP Settings') ?? '').split(';');
                const period = parseInt(settings[0] ?? '30', 10);
                const digits = parseInt(settings[1] ?? '6', 10);
                return {
                    secret,
                    period: Number.isFinite(period) && period > 0 ? period : 30,
                    digits: Number.isFinite(digits) && digits >= 6 && digits <= 8 ? digits : 6,
                    algorithm: 'SHA-1',
                };
            }
        }

        return null;
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

    static async generateCode(config: TotpConfig, nowMs = Date.now()): Promise<string> {
        const counter = Math.floor(nowMs / 1000 / config.period);
        const counterBytes = new Uint8Array(8);
        // 32-bit ops are enough: the high word of the counter is 0 until year 6053
        new DataView(counterBytes.buffer).setUint32(4, counter);

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

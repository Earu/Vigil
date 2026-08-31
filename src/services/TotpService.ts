import * as kdbxweb from 'kdbxweb';
import { CustomField } from '../types/database';

export interface TotpConfig {
    secret: string; // normalized base32, no padding or separators
    period: number;
    digits: number;
    algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
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

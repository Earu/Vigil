import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TotpService } from '../../src/services/TotpService';
import { settings, anyText, withinMs } from './fuzz';

// One-time code configuration comes from pasted text, scanned QR codes and
// fields in shared databases. Every parser here answers null or a config;
// a config it produced must generate a code without throwing

const base32 = fc.stringMatching(/^[A-Z2-7]{16,64}=*$/);
const otpauth = fc.record({
    secret: fc.oneof(base32, anyText()),
    issuer: anyText(),
    algorithm: fc.oneof(fc.constantFrom('SHA1', 'SHA256', 'SHA512', 'sha1', 'MD5'), anyText()),
    digits: fc.oneof(fc.constantFrom('6', '7', '8', '0', '-1', '100'), anyText()),
    period: fc.oneof(fc.constantFrom('30', '60', '0', '-5', '1e9'), anyText()),
    label: anyText(),
}).map(({ secret, issuer, algorithm, digits, period, label }) => {
    const params = new URLSearchParams({ secret, issuer, algorithm, digits, period });
    return `otpauth://totp/${encodeURIComponent(label)}?${params}`;
});

describe('TOTP parsing under fuzz', () => {
    it('parseOtpAuthUri answers for any text, and a config it returns generates a code', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(otpauth, anyText()), async (text) => {
            let config: ReturnType<typeof TotpService.parseOtpAuthUri> = null;
            await withinMs(200, () => { config = TotpService.parseOtpAuthUri(text); });
            if (config === null) return;
            const code = await TotpService.generateCode(config, 1_700_000_000_000);
            expect(code).toMatch(/^[0-9A-Z]+$/);
            expect(TotpService.secondsRemaining(config, 1_700_000_000_000)).toBeGreaterThan(0);
        }), settings());
    });

    it('user input and migration URIs answer null or a value, never throw', () => {
        fc.assert(fc.property(fc.oneof(anyText(), otpauth, base32, anyText().map(t => `otpauth-migration://offline?data=${encodeURIComponent(t)}`)), (text) => {
            expect(() => TotpService.parseUserInput(text)).not.toThrow();
            expect(() => TotpService.parseMigrationUri(text)).not.toThrow();
            expect(() => TotpService.normalizeSecret(text)).not.toThrow();
        }), settings());
    });

    it('getConfig tolerates any custom field set', () => {
        const field = fc.record({ key: fc.oneof(fc.constantFrom('otp', 'TOTP Seed', 'TOTP Settings', 'TimeOtp-Secret-Base32', 'HmacOtp-Secret'), anyText()), value: anyText(), protected: fc.boolean() });
        fc.assert(fc.property(fc.array(field, { maxLength: 6 }), (fields) => {
            expect(() => TotpService.getConfig(fields as any)).not.toThrow();
        }), settings());
    });

    it('a well-formed URI round-trips through build and parse', () => {
        fc.assert(fc.property(base32.filter(s => !s.includes('=')), fc.constantFrom('SHA1', 'SHA256', 'SHA512'), fc.constantFrom(6, 7, 8), fc.constantFrom(30, 60), fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/), (secret, algorithm, digits, period, label) => {
            const parsed = TotpService.parseOtpAuthUri(`otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&algorithm=${algorithm}&digits=${digits}&period=${period}`);
            fc.pre(parsed !== null);
            const again = TotpService.parseOtpAuthUri(TotpService.buildOtpAuthUri(parsed!, label));
            expect(again).toEqual(parsed);
        }), settings());
    });

    it('a migration payload of any bytes answers null or accounts', () => {
        fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (payload) => {
            const uri = `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(payload).toString('base64'))}`;
            const result = TotpService.parseMigrationUri(uri);
            expect(result === null || Array.isArray(result)).toBe(true);
        }), settings());
    });
});

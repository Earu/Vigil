import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TotpService } from '../../src/services/TotpService';
import { settings, anyText, withinMs } from './fuzz';

// One-time code configuration comes from pasted text, scanned QR codes and
// fields in shared databases. Every parser here answers null or a config;
// a config it produced must generate a code without throwing

const base32 = fc.stringMatching(/^[A-Z2-7]{16,64}=*$/);
const otpauth = fc.record({
    host: fc.constantFrom('totp', 'hotp', 'HOTP', 'ocra'),
    secret: fc.oneof(base32, anyText()),
    issuer: anyText(),
    algorithm: fc.oneof(fc.constantFrom('SHA1', 'SHA256', 'SHA512', 'sha1', 'MD5'), anyText()),
    digits: fc.oneof(fc.constantFrom('6', '7', '8', '0', '-1', '100'), anyText()),
    period: fc.oneof(fc.constantFrom('30', '60', '0', '-5', '1e9'), anyText()),
    counter: fc.oneof(fc.constantFrom('0', '1', '42', '-1', '1e30', '9007199254740993'), anyText()),
    label: anyText(),
}).map(({ host, secret, issuer, algorithm, digits, period, counter, label }) => {
    const params = new URLSearchParams({ secret, issuer, algorithm, digits, period, counter });
    return `otpauth://${host}/${encodeURIComponent(label)}?${params}`;
});

const otpKeys = ['otp', 'TOTP Seed', 'TOTP Settings', 'TimeOtp-Secret-Base32', 'HmacOtp-Secret-Base32', 'HmacOtp-Counter', 'hmacotp-counter'];

describe('TOTP parsing under fuzz', () => {
    it('parseOtpAuthUri answers for any text, and a config it returns generates a code', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(otpauth, anyText()), async (text) => {
            let config: ReturnType<typeof TotpService.parseOtpAuthUri> = null;
            await withinMs(200, () => { config = TotpService.parseOtpAuthUri(text); });
            if (config === null) return;
            const code = await TotpService.generateCode(config, 1_700_000_000_000);
            expect(code).toMatch(/^[0-9A-Z]+$/);
            if (config.type === 'totp') {
                expect(TotpService.secondsRemaining(config, 1_700_000_000_000)).toBeGreaterThan(0);
            } else {
                expect(Number.isSafeInteger(config.counter) && config.counter >= 0).toBe(true);
            }
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
        const field = fc.record({ key: fc.oneof(fc.constantFrom(...otpKeys), anyText()), value: anyText(), protected: fc.boolean() });
        fc.assert(fc.property(fc.array(field, { maxLength: 6 }), (fields) => {
            expect(() => TotpService.getConfig(fields as any)).not.toThrow();
        }), settings());
    });

    it('withCounter never throws, and a moved counter reads back', () => {
        const hotpUri = base32.map(s => `otpauth://hotp/x?secret=${s}`);
        const field = fc.record({
            key: fc.oneof(fc.constantFrom(...otpKeys), anyText()),
            value: fc.oneof(anyText(), base32, hotpUri, otpauth),
            protected: fc.boolean(),
        });
        fc.assert(fc.property(fc.array(field, { maxLength: 6 }), fc.nat(), (fields, counter) => {
            let moved: any[] = [];
            expect(() => { moved = TotpService.withCounter(fields as any, counter); }).not.toThrow();
            const before = TotpService.getConfig(fields as any);
            if (before?.type !== 'hotp') {
                expect(moved).toBe(fields);
                return;
            }
            const key = TotpService.counterField(fields as any, counter)!.key.toLowerCase();
            const existed = fields.some(f => f.key.toLowerCase() === key);
            expect(moved).toHaveLength(fields.length + (existed ? 0 : 1));
            const after = TotpService.getConfig(moved as any);
            expect(after).toMatchObject({ type: 'hotp', counter, secret: before.secret });
        }), settings());
    });

    it('a well-formed URI round-trips through build and parse', () => {
        fc.assert(fc.property(base32.filter(s => !s.includes('=')), fc.constantFrom('SHA1', 'SHA256', 'SHA512'), fc.constantFrom(6, 7, 8), fc.constantFrom(30, 60), fc.nat(), fc.boolean(), fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/), (secret, algorithm, digits, period, counter, timeBased, label) => {
            const tail = timeBased ? `period=${period}` : `counter=${counter}`;
            const parsed = TotpService.parseOtpAuthUri(`otpauth://${timeBased ? 'totp' : 'hotp'}/${encodeURIComponent(label)}?secret=${secret}&algorithm=${algorithm}&digits=${digits}&${tail}`);
            fc.pre(parsed !== null);
            expect(parsed!.type).toBe(timeBased ? 'totp' : 'hotp');
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

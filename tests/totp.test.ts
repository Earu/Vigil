import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { TotpService, HotpConfig } from '../src/services/TotpService';
import { CustomField } from '../src/types/database';

const SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SHA512_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

const field = (key: string, value: string, isProtected = false): CustomField => ({ key, value, protected: isProtected });
const hotp = (counter: number, overrides: Partial<HotpConfig> = {}): HotpConfig =>
    ({ type: 'hotp', secret: SHA1_SECRET, digits: 6, algorithm: 'SHA-1', counter, ...overrides });

describe('TOTP code generation (RFC 6238 vectors)', () => {
    it('matches SHA-1 vectors', async () => {
        const cfg = { type: 'totp' as const, secret: SHA1_SECRET, period: 30, digits: 8, algorithm: 'SHA-1' as const };
        expect(await TotpService.generateCode(cfg, 59_000)).toBe('94287082');
        expect(await TotpService.generateCode(cfg, 1_111_111_109_000)).toBe('07081804');
        expect(await TotpService.generateCode(cfg, 1_234_567_890_000)).toBe('89005924');
        expect(await TotpService.generateCode(cfg, 20_000_000_000_000)).toBe('65353130');
    });

    it('matches SHA-256 and SHA-512 vectors', async () => {
        expect(await TotpService.generateCode(
            { type: 'totp', secret: SHA256_SECRET, period: 30, digits: 8, algorithm: 'SHA-256' }, 59_000
        )).toBe('46119246');
        expect(await TotpService.generateCode(
            { type: 'totp', secret: SHA512_SECRET, period: 30, digits: 8, algorithm: 'SHA-512' }, 59_000
        )).toBe('90693936');
    });

    it('produces 6-digit codes by default', async () => {
        const code = await TotpService.generateCode(
            { type: 'totp', secret: SHA1_SECRET, period: 30, digits: 6, algorithm: 'SHA-1' }, 59_000
        );
        expect(code).toBe('287082');
    });

    it('reports seconds remaining in the period', () => {
        const cfg = { type: 'totp' as const, secret: SHA1_SECRET, period: 30, digits: 6, algorithm: 'SHA-1' as const };
        expect(TotpService.secondsRemaining(cfg, 0)).toBe(30);
        expect(TotpService.secondsRemaining(cfg, 29_000)).toBe(1);
        expect(TotpService.secondsRemaining(cfg, 30_000)).toBe(30);
        expect(TotpService.secondsRemaining(cfg, 44_500)).toBe(16);
    });
});

describe('HOTP code generation (RFC 4226 vectors)', () => {
    it('matches the counters 0 to 9', async () => {
        const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
        for (let counter = 0; counter < expected.length; counter++) {
            expect(await TotpService.generateCode(hotp(counter))).toBe(expected[counter]);
        }
    });

    it('ignores the clock', async () => {
        expect(await TotpService.generateCode(hotp(3), 0)).toBe('969429');
        expect(await TotpService.generateCode(hotp(3), 20_000_000_000_000)).toBe('969429');
    });

    it('writes the high word of a counter beyond 32 bits', async () => {
        const low = await TotpService.generateCode(hotp(1));
        const high = await TotpService.generateCode(hotp(2 ** 32 + 1));
        expect(high).toMatch(/^\d{6}$/);
        expect(high).not.toBe(low);
    });
});

describe('TOTP config parsing', () => {
    it('parses an otpauth URI with parameters', () => {
        const cfg = TotpService.parseOtpAuthUri(
            `otpauth://totp/Example:user@example.com?secret=${SHA1_SECRET}&issuer=Example&algorithm=SHA256&digits=8&period=60`
        );
        expect(cfg).toEqual({ type: 'totp', secret: SHA1_SECRET, period: 60, digits: 8, algorithm: 'SHA-256' });
    });

    it('rejects unknown hosts and garbage', () => {
        expect(TotpService.parseOtpAuthUri(`otpauth://ocra/x?secret=${SHA1_SECRET}`)).toBeNull();
        expect(TotpService.parseOtpAuthUri('https://example.com')).toBeNull();
        expect(TotpService.parseUserInput('not base32!!')).toBeNull();
        expect(TotpService.parseUserInput('')).toBeNull();
    });

    it('accepts a bare secret with spaces and lowercase, as TOTP', () => {
        const cfg = TotpService.parseUserInput('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
        expect(cfg).toEqual({ type: 'totp', secret: SHA1_SECRET, period: 30, digits: 6, algorithm: 'SHA-1' });
    });

    it('reads the otp field, protected or not', () => {
        const uri = `otpauth://totp/x?secret=${SHA1_SECRET}`;
        expect(TotpService.getConfig([field('otp', uri)])?.secret).toBe(SHA1_SECRET);
        expect(TotpService.getConfig([
            { key: 'otp', value: kdbxweb.ProtectedValue.fromString(uri), protected: true }
        ])?.secret).toBe(SHA1_SECRET);
    });

    it('reads KeePass TimeOtp fields', () => {
        const cfg = TotpService.getConfig([
            field('TimeOtp-Secret-Base32', SHA1_SECRET),
            field('TimeOtp-Length', '8'),
            field('TimeOtp-Period', '60'),
            field('TimeOtp-Algorithm', 'HMAC-SHA-256'),
        ]);
        expect(cfg).toEqual({ type: 'totp', secret: SHA1_SECRET, period: 60, digits: 8, algorithm: 'SHA-256' });
    });

    it('reads KeeTrayTOTP seed and settings', () => {
        const cfg = TotpService.getConfig([
            field('TOTP Seed', SHA1_SECRET),
            field('TOTP Settings', '60;8'),
        ]);
        expect(cfg).toEqual({ type: 'totp', secret: SHA1_SECRET, period: 60, digits: 8, algorithm: 'SHA-1' });
    });

    it('returns null when no OTP fields exist', () => {
        expect(TotpService.getConfig([field('PIN', '1234')])).toBeNull();
    });

    it('round-trips through buildOtpAuthUri', () => {
        const cfg = { type: 'totp' as const, secret: SHA1_SECRET, period: 45, digits: 7, algorithm: 'SHA-512' as const };
        expect(TotpService.parseOtpAuthUri(TotpService.buildOtpAuthUri(cfg, 'My Site'))).toEqual(cfg);
    });

    it('identifies OTP field keys case-insensitively', () => {
        expect(TotpService.isTotpKey('otp')).toBe(true);
        expect(TotpService.isTotpKey('OTP')).toBe(true);
        expect(TotpService.isTotpKey('TimeOtp-Secret-Base32')).toBe(true);
        expect(TotpService.isTotpKey('TOTP Seed')).toBe(true);
        expect(TotpService.isTotpKey('HmacOtp-Secret-Base32')).toBe(true);
        expect(TotpService.isTotpKey('hmacotp-counter')).toBe(true);
        expect(TotpService.isTotpKey('PIN')).toBe(false);
    });
});

describe('HOTP config parsing', () => {
    it('parses an hotp URI with parameters', () => {
        const cfg = TotpService.parseOtpAuthUri(
            `otpauth://hotp/Example:user?secret=${SHA1_SECRET}&issuer=Example&counter=42&digits=8&algorithm=SHA256`
        );
        expect(cfg).toEqual({ type: 'hotp', secret: SHA1_SECRET, digits: 8, algorithm: 'SHA-256', counter: 42 });
    });

    it('falls back to counter 0 when the parameter is missing or unusable', () => {
        const uri = (counter?: string) => `otpauth://hotp/x?secret=${SHA1_SECRET}${counter === undefined ? '' : `&counter=${counter}`}`;
        expect(TotpService.parseOtpAuthUri(uri())).toMatchObject({ type: 'hotp', counter: 0 });
        expect(TotpService.parseOtpAuthUri(uri('-3'))).toMatchObject({ counter: 0 });
        expect(TotpService.parseOtpAuthUri(uri('abc'))).toMatchObject({ counter: 0 });
        expect(TotpService.parseOtpAuthUri(uri('99999999999999999999'))).toMatchObject({ counter: 0 });
    });

    it('round-trips through buildOtpAuthUri with a counter and no period', () => {
        const cfg = hotp(7, { digits: 7, algorithm: 'SHA-512' });
        const uri = TotpService.buildOtpAuthUri(cfg, 'My Site');
        expect(uri).toMatch(/^otpauth:\/\/hotp\//);
        expect(uri).toContain('counter=7');
        expect(uri).not.toContain('period=');
        expect(TotpService.parseOtpAuthUri(uri)).toEqual(cfg);
    });

    it('accepts an hotp URI as user input', () => {
        expect(TotpService.parseUserInput(`otpauth://hotp/x?secret=${SHA1_SECRET}&counter=2`)).toEqual(hotp(2));
    });

    it('reads KeePass HmacOtp fields', () => {
        expect(TotpService.getConfig([
            field('HmacOtp-Secret-Base32', SHA1_SECRET),
            field('HmacOtp-Counter', '5'),
        ])).toEqual(hotp(5));
        expect(TotpService.getConfig([field('HmacOtp-Secret-Base32', SHA1_SECRET)])).toEqual(hotp(0));
    });

    it('prefers TimeOtp when an entry carries both KeePass conventions', () => {
        const cfg = TotpService.getConfig([
            field('HmacOtp-Secret-Base32', SHA1_SECRET),
            field('HmacOtp-Counter', '5'),
            field('TimeOtp-Secret-Base32', SHA1_SECRET),
        ]);
        expect(cfg?.type).toBe('totp');
    });
});

describe('HOTP counter write-back', () => {
    it('rewrites only the counter parameter of an otp URI', () => {
        const fields = [
            field('PIN', '1234'),
            field('otp', `otpauth://hotp/Ex:alice?secret=${SHA1_SECRET}&issuer=Ex&counter=3`, true),
        ];
        const next = TotpService.counterField(fields, 4)!;
        expect(next.key).toBe('otp');
        expect(next.protected).toBe(true);
        expect(next.value).toMatch(/^otpauth:\/\/hotp\/Ex:alice\?/);
        expect(next.value).toContain('issuer=Ex');
        expect(next.value).toContain('counter=4');
        expect(next.value).not.toContain('counter=3');

        const updated = TotpService.withCounter(fields, 4);
        expect(updated).toHaveLength(2);
        expect(updated[0]).toBe(fields[0]);
        expect(TotpService.getConfig(updated)).toEqual(hotp(4));
    });

    it('adds a counter parameter to a URI that had none', () => {
        const fields = [field('otp', `otpauth://hotp/x?secret=${SHA1_SECRET}`)];
        expect(TotpService.getConfig(TotpService.withCounter(fields, 1))).toEqual(hotp(1));
    });

    it('replaces HmacOtp-Counter in place, keeping its key spelling', () => {
        const fields = [
            field('HmacOtp-Secret-Base32', SHA1_SECRET),
            field('hmacotp-counter', '3', true),
            field('PIN', '1234'),
        ];
        const updated = TotpService.withCounter(fields, 4);
        expect(updated).toHaveLength(3);
        expect(updated[1]).toEqual({ key: 'hmacotp-counter', value: '4', protected: true });
        expect(updated.some(f => f.key === 'otp')).toBe(false);
    });

    it('appends HmacOtp-Counter when the entry has none', () => {
        const fields = [field('HmacOtp-Secret-Base32', SHA1_SECRET)];
        const updated = TotpService.withCounter(fields, 9);
        expect(updated).toHaveLength(2);
        expect(updated[1]).toEqual({ key: 'HmacOtp-Counter', value: '9', protected: false });
    });

    it('leaves a TOTP entry untouched', () => {
        const fields = [field('otp', `otpauth://totp/x?secret=${SHA1_SECRET}`)];
        expect(TotpService.counterField(fields, 1)).toBeNull();
        expect(TotpService.withCounter(fields, 1)).toBe(fields);
    });
});

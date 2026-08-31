import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { TotpService } from '../src/services/TotpService';
import { CustomField } from '../src/types/database';

const SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SHA512_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

const field = (key: string, value: string): CustomField => ({ key, value, protected: false });

describe('TOTP code generation (RFC 6238 vectors)', () => {
    it('matches SHA-1 vectors', async () => {
        const cfg = { secret: SHA1_SECRET, period: 30, digits: 8, algorithm: 'SHA-1' as const };
        expect(await TotpService.generateCode(cfg, 59_000)).toBe('94287082');
        expect(await TotpService.generateCode(cfg, 1_111_111_109_000)).toBe('07081804');
        expect(await TotpService.generateCode(cfg, 1_234_567_890_000)).toBe('89005924');
        expect(await TotpService.generateCode(cfg, 20_000_000_000_000)).toBe('65353130');
    });

    it('matches SHA-256 and SHA-512 vectors', async () => {
        expect(await TotpService.generateCode(
            { secret: SHA256_SECRET, period: 30, digits: 8, algorithm: 'SHA-256' }, 59_000
        )).toBe('46119246');
        expect(await TotpService.generateCode(
            { secret: SHA512_SECRET, period: 30, digits: 8, algorithm: 'SHA-512' }, 59_000
        )).toBe('90693936');
    });

    it('produces 6-digit codes by default', async () => {
        const code = await TotpService.generateCode(
            { secret: SHA1_SECRET, period: 30, digits: 6, algorithm: 'SHA-1' }, 59_000
        );
        expect(code).toBe('287082');
    });

    it('reports seconds remaining in the period', () => {
        const cfg = { secret: SHA1_SECRET, period: 30, digits: 6, algorithm: 'SHA-1' as const };
        expect(TotpService.secondsRemaining(cfg, 0)).toBe(30);
        expect(TotpService.secondsRemaining(cfg, 29_000)).toBe(1);
        expect(TotpService.secondsRemaining(cfg, 30_000)).toBe(30);
        expect(TotpService.secondsRemaining(cfg, 44_500)).toBe(16);
    });
});

describe('TOTP config parsing', () => {
    it('parses an otpauth URI with parameters', () => {
        const cfg = TotpService.parseOtpAuthUri(
            `otpauth://totp/Example:user@example.com?secret=${SHA1_SECRET}&issuer=Example&algorithm=SHA256&digits=8&period=60`
        );
        expect(cfg).toEqual({ secret: SHA1_SECRET, period: 60, digits: 8, algorithm: 'SHA-256' });
    });

    it('rejects hotp URIs and garbage', () => {
        expect(TotpService.parseOtpAuthUri(`otpauth://hotp/x?secret=${SHA1_SECRET}`)).toBeNull();
        expect(TotpService.parseOtpAuthUri('https://example.com')).toBeNull();
        expect(TotpService.parseUserInput('not base32!!')).toBeNull();
        expect(TotpService.parseUserInput('')).toBeNull();
    });

    it('accepts a bare secret with spaces and lowercase', () => {
        const cfg = TotpService.parseUserInput('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
        expect(cfg).toEqual({ secret: SHA1_SECRET, period: 30, digits: 6, algorithm: 'SHA-1' });
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
        expect(cfg).toEqual({ secret: SHA1_SECRET, period: 60, digits: 8, algorithm: 'SHA-256' });
    });

    it('reads KeeTrayTOTP seed and settings', () => {
        const cfg = TotpService.getConfig([
            field('TOTP Seed', SHA1_SECRET),
            field('TOTP Settings', '60;8'),
        ]);
        expect(cfg).toEqual({ secret: SHA1_SECRET, period: 60, digits: 8, algorithm: 'SHA-1' });
    });

    it('returns null when no TOTP fields exist', () => {
        expect(TotpService.getConfig([field('PIN', '1234')])).toBeNull();
    });

    it('round-trips through buildOtpAuthUri', () => {
        const cfg = { secret: SHA1_SECRET, period: 45, digits: 7, algorithm: 'SHA-512' as const };
        expect(TotpService.parseOtpAuthUri(TotpService.buildOtpAuthUri(cfg, 'My Site'))).toEqual(cfg);
    });

    it('identifies TOTP field keys case-insensitively', () => {
        expect(TotpService.isTotpKey('otp')).toBe(true);
        expect(TotpService.isTotpKey('OTP')).toBe(true);
        expect(TotpService.isTotpKey('TimeOtp-Secret-Base32')).toBe(true);
        expect(TotpService.isTotpKey('TOTP Seed')).toBe(true);
        expect(TotpService.isTotpKey('PIN')).toBe(false);
    });
});

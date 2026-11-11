import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpret, parseLockout } = require('../electron/native/tpm/index.js');

describe('TPM lockout settings', () => {
    const encode = (...values: number[]) => {
        const data = Buffer.alloc(values.length * 4);
        values.forEach((value, i) => data.writeUInt32BE(value, i * 4));
        return data;
    };

    it('reads the lockout password flag, the limits and the failure count', () => {
        expect(parseLockout(encode(0x4, 32, 7200, 86400, 2))).toEqual(
            { ok: true, lockoutAuthSet: true, maxTries: 32, recoveryInterval: 7200, lockoutRecovery: 86400, failures: 2 });
        expect(parseLockout(encode(0x3, 0xffffffff, 0, 0, 0))).toEqual(
            { ok: true, lockoutAuthSet: false, maxTries: 0xffffffff, recoveryInterval: 0, lockoutRecovery: 0, failures: 0 });
    });

    it('refuses anything but five values', () => {
        expect(parseLockout(encode(0x4, 32, 7200)).ok).toBe(false);
        expect(parseLockout(Buffer.alloc(24)).ok).toBe(false);
        expect(parseLockout(undefined).ok).toBe(false);
    });
});

describe('TPM status interpretation on Windows', () => {
    it.each([
        [0, 'ok'],
        [0x80090016, 'not-found'],
        [0x80090011, 'not-found'],
        [0x8028008e, 'wrong-pin'],
        [0x802800a2, 'wrong-pin'],
        [0x80280001, 'wrong-pin'],
        [0x8010006b, 'wrong-pin'],
        [0x80090010, 'wrong-pin'],
        [0x80280921, 'locked-out'],
        [0x80280803, 'locked-out'],
        [0x8010006c, 'locked-out'],
        [0x8028400f, 'unavailable'],
        [0x80090030, 'unavailable'],
        [0x8009000f, 'error'],
        [0xfffffffd, 'tampered'],
        [0xfffffffe, 'bad-input'],
    ])('0x%s is %s', (status, code) => {
        expect(interpret('win', status)).toBe(code);
    });
});

describe('TPM status interpretation on Linux', () => {
    it.each([
        [0, 'ok'],
        [0x98e, 'wrong-pin'],
        [0x08e, 'wrong-pin'],
        [0x9a2, 'wrong-pin'],
        [0x921, 'locked-out'],
        [0x0c0921, 'locked-out'],
        [0x0b098e, 'wrong-pin'],
        [0x1df, 'not-found'],
        [0x0a000a, 'unavailable'],
        [0x070005, 'unavailable'],
        [0x090004, 'error'],
        [0x18b, 'error'],
        [0xfffffffe, 'bad-input'],
    ])('0x%s is %s', (status, code) => {
        expect(interpret('linux', status)).toBe(code);
    });
});

describe('TPM status interpretation without the addon', () => {
    it('reports anything but success as unavailable', () => {
        expect(interpret('stub', 0xffffffff)).toBe('unavailable');
        expect(interpret('none', 0x98e)).toBe('unavailable');
    });
});

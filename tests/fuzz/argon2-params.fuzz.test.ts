import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkArgon2Params, MAX_WORK_KIB_PASSES } from '../../electron/src/crypto';
import { settings } from './fuzz';

// KDF parameters come straight out of a file the user may have been sent.
// Whatever the header says, the cap either accepts a workload the app can do
// or refuses; it never lets a value through that would allocate past the
// machine or spin for years

const number = () => fc.oneof(
    fc.integer({ min: -10, max: 10 }),
    fc.integer({ min: 0, max: 2 ** 31 }),
    fc.double({ noDefaultInfinity: false, noNaN: false }),
    fc.constantFrom(NaN, Infinity, -Infinity, -0, 2 ** 53, 8, 16, 128, 1_000_000, 1_000_001),
);
const totalMemory = fc.integer({ min: 512 * 1024 * 1024, max: 1024 * 1024 * 1024 * 1024 });

describe('argon2 parameter cap under fuzz', () => {
    it('whatever passes is inside every bound', () => {
        fc.assert(fc.property(number(), number(), number(), number(), totalMemory, (memory, iterations, parallelism, length, ram) => {
            let accepted = true;
            try {
                checkArgon2Params(memory, iterations, parallelism, length, ram);
            } catch (error) {
                accepted = false;
                expect(error).toBeInstanceOf(Error);
            }
            if (accepted) {
                expect(memory).toBeGreaterThanOrEqual(8);
                expect(memory).toBeLessThanOrEqual(4 * 1024 * 1024);
                expect(memory).toBeLessThanOrEqual(ram / 2 / 1024);
                expect(iterations).toBeGreaterThanOrEqual(1);
                expect(iterations).toBeLessThanOrEqual(1_000_000);
                expect(parallelism).toBeGreaterThanOrEqual(1);
                expect(parallelism).toBeLessThanOrEqual(256);
                expect(length).toBeGreaterThanOrEqual(16);
                expect(length).toBeLessThanOrEqual(128);
                expect(memory * iterations).toBeLessThanOrEqual(MAX_WORK_KIB_PASSES);
                for (const value of [memory, iterations, parallelism, length]) expect(Number.isFinite(value)).toBe(true);
            }
        }), settings());
    });

    it('accepts every workload a real vault carries', () => {
        // 8 MiB to 1 GiB of memory, up to 64 passes, on a machine with 4 GiB
        fc.assert(fc.property(
            fc.integer({ min: 8 * 1024, max: 1024 * 1024 }),
            fc.integer({ min: 1, max: 64 }),
            fc.integer({ min: 1, max: 8 }),
            fc.constantFrom(32, 64),
            (memory, iterations, parallelism, length) => {
                expect(() => checkArgon2Params(memory, iterations, parallelism, length, 4 * 1024 * 1024 * 1024)).not.toThrow();
            }), settings());
    });
});

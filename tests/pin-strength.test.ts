import { describe, it, expect, beforeAll } from 'vitest';

const { HaveIBeenPwnedService: Hibp } = await import('../src/services/HaveIBeenPwnedService');

describe('easy PIN warning', () => {
    it('gives no verdict before the estimator has loaded', () => {
        expect(Hibp.isEasyPin('123456')).toBeNull();
    });

    describe('once loaded', () => {
        beforeAll(() => Hibp.preloadStrengthEstimator());

        it.each(['123456', '654321', '111111', '000000', '123123', '121212', '112233', '159753', '147258', '520520', '1234567890'])(
            'flags %s, a common PIN, repeat or sequence',
            (pin) => {
                expect(Hibp.isEasyPin(pin)).toBe(true);
            }
        );

        it.each(['482915', '739204', '605127', '8462095173'])('leaves %s, a random PIN, alone', (pin) => {
            expect(Hibp.isEasyPin(pin)).toBe(false);
        });

        it('leaves dates alone, which would flag several percent of random PINs', () => {
            expect(Hibp.isEasyPin('250990')).toBe(false);
            expect(Hibp.isEasyPin('051289')).toBe(false);
        });

        describe('where the TPM allows 31 tries and one more every 10 minutes', () => {
            const PER_YEAR = 31 + 52560;

            it.each(['250990', '051289', '19900525', '123456', '90210'])('refuses %s, guessed within a year', (pin) => {
                expect(Hibp.isEasyPin(pin, PER_YEAR)).toBe(true);
            });

            it.each(['482915', '739204', '605127', '8462095173'])('takes %s, a random PIN', (pin) => {
                expect(Hibp.isEasyPin(pin, PER_YEAR)).toBe(false);
            });
        });

        it('still refuses the most common PINs where only a few tries are allowed', () => {
            expect(Hibp.isEasyPin('147258', 5)).toBe(true);
            expect(Hibp.isEasyPin('250990', 5)).toBe(false);
        });
    });
});

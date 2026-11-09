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
    });
});

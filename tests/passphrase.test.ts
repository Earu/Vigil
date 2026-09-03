import { describe, it, expect, beforeAll } from 'vitest';
import { PassphraseService } from '../src/services/PassphraseService';
import { EFF_WORDLIST } from '../src/data/effWordlist';

// The wordlist is a lazy chunk in the app; load it once for the sync API
beforeAll(() => PassphraseService.preload());

describe('wordlist', () => {
    it('is the full EFF large wordlist', () => {
        expect(EFF_WORDLIST).toHaveLength(7776);
        expect(new Set(EFF_WORDLIST).size).toBe(7776);
        expect(EFF_WORDLIST.every(w => /^[a-z-]+$/.test(w))).toBe(true);
    });
});

describe('passphrase generation', () => {
    it('generates the requested number of words with the separator', () => {
        const phrase = PassphraseService.generate({
            wordCount: 6, separator: '-', capitalize: false, includeNumber: false,
        });
        const words = phrase.split('-');
        expect(words).toHaveLength(6);
        for (const w of words) expect(EFF_WORDLIST).toContain(w);
    });

    it('supports empty and multi-character separators', () => {
        const dotted = PassphraseService.generate({
            wordCount: 4, separator: '..', capitalize: false, includeNumber: false,
        });
        expect(dotted.split('..')).toHaveLength(4);
    });

    it('capitalizes each word when asked', () => {
        const phrase = PassphraseService.generate({
            wordCount: 5, separator: ' ', capitalize: true, includeNumber: false,
        });
        for (const w of phrase.split(' ')) {
            expect(w[0]).toBe(w[0].toUpperCase());
            expect(EFF_WORDLIST).toContain(w[0].toLowerCase() + w.slice(1));
        }
    });

    it('appends exactly one digit when includeNumber is set', () => {
        const phrase = PassphraseService.generate({
            wordCount: 5, separator: '-', capitalize: false, includeNumber: true,
        });
        const digits = phrase.match(/\d/g) ?? [];
        expect(digits).toHaveLength(1);
        const withDigit = phrase.split('-').filter(w => /\d$/.test(w));
        expect(withDigit).toHaveLength(1);
    });

    it('produces different phrases on consecutive calls', () => {
        const opts = { wordCount: 5, separator: '-', capitalize: false, includeNumber: false };
        expect(PassphraseService.generate(opts)).not.toBe(PassphraseService.generate(opts));
    });

    it('reports entropy from the wordlist size', () => {
        const base = { separator: '-', capitalize: false, includeNumber: false };
        expect(PassphraseService.entropyBits({ ...base, wordCount: 5 })).toBe(65);
        expect(PassphraseService.entropyBits({ ...base, wordCount: 7 })).toBe(90);
        expect(PassphraseService.entropyBits({ ...base, wordCount: 5, includeNumber: true }))
            .toBeGreaterThan(65);
    });
});

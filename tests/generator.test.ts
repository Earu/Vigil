import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
    PasswordGeneratorService as Gen,
    DEFAULT_CHARACTER_OPTIONS,
    DEFAULT_WORD_OPTIONS,
} from '../src/services/PasswordGeneratorService';
import { PassphraseService } from '../src/services/PassphraseService';
import { BrowserIntegrationService } from '../src/services/BrowserIntegrationService';

// The wordlist is a lazy chunk in the app; words mode needs it loaded
beforeAll(() => PassphraseService.preload());

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
};

beforeEach(() => store.clear());

const digitsOnly = {
    ...DEFAULT_CHARACTER_OPTIONS,
    upperCase: false, lowerCase: false, special: false, digits: true,
};

describe('character pool', () => {
    it('reflects the selected sets and custom characters', () => {
        expect(Gen.characterPool({ ...digitsOnly, customChars: 'xyz' })).toBe('0123456789xyz');
        expect(Gen.characterPool({ ...digitsOnly, digits: false })).toBe('');
    });
});

describe('generate', () => {
    it('honors length and draws only from the pool', () => {
        const password = Gen.generate({ ...digitsOnly, length: 40 });
        expect(password).toMatch(/^[0-9]{40}$/);
    });

    it('throws when no character set is selected', () => {
        expect(() => Gen.generate({ ...digitsOnly, digits: false })).toThrow();
    });
});

describe('character pool deduplication', () => {
    it('does not repeat characters the sets share', () => {
        // brackets/minus/underline all repeat characters from the special set
        const pool = Gen.characterPool({
            ...DEFAULT_CHARACTER_OPTIONS,
            upperCase: false, lowerCase: false, digits: false,
            special: true, brackets: true, minus: true, underline: true,
        });
        expect(pool.length).toBe(new Set(pool).size);
        expect(pool).toContain('[');
        expect(pool).toContain('-');
        expect(pool).toContain('_');
    });

    it('does not repeat custom characters already in a selected set', () => {
        const pool = Gen.characterPool({ ...digitsOnly, customChars: '0123abc' });
        expect(pool).toBe('0123456789abc');
    });

    it('keeps every selected set represented', () => {
        const pool = Gen.characterPool({
            ...DEFAULT_CHARACTER_OPTIONS, latin1: true, space: true,
        });
        expect(pool).toMatch(/[A-Z]/);
        expect(pool).toMatch(/[a-z]/);
        expect(pool).toMatch(/[0-9]/);
        expect(pool).toContain('!');
        expect(pool).toContain(' ');
        expect(pool).toContain('\u00c0');
        expect(pool.length).toBe(new Set(pool).size);
    });
});

describe('generate: pools larger than 256 characters', () => {
    // A pool over 256 made the old 8-bit rejection limit collapse to zero, so
    // no draw was ever accepted and the loop span forever on the UI thread
    const bigCustom = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x100 + i)).join('');

    it('terminates and honors length', () => {
        const options = { ...DEFAULT_CHARACTER_OPTIONS, length: 24, customChars: bigCustom };
        expect(Gen.characterPool(options).length).toBeGreaterThan(256);
        const password = Gen.generate(options);
        expect([...password]).toHaveLength(24);
    });

    it('draws only from the pool', () => {
        const options = { ...digitsOnly, length: 50, customChars: bigCustom };
        const pool = new Set([...Gen.characterPool(options)]);
        for (const ch of Gen.generate(options)) expect(pool.has(ch)).toBe(true);
    });
});

describe('generate: distribution', () => {
    it('does not favour characters that appear in more than one set', () => {
        // '(' is in both special and brackets; before dedupe it came up about
        // twice as often as a character unique to the special set
        const options = {
            ...DEFAULT_CHARACTER_OPTIONS,
            upperCase: false, lowerCase: false, digits: false,
            special: true, brackets: true, length: 4000,
        };
        const poolSize = Gen.characterPool(options).length;
        const sample = Gen.generate(options);
        const counts = new Map<string, number>();
        for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1);

        const expected = sample.length / poolSize;
        const duplicated = counts.get('(') ?? 0;
        const unique = counts.get('!') ?? 0;
        // Generous bounds: this asserts "not 2x", not a precise uniformity test
        expect(duplicated).toBeGreaterThan(expected * 0.5);
        expect(duplicated).toBeLessThan(expected * 1.5);
        expect(unique).toBeGreaterThan(expected * 0.5);
        expect(unique).toBeLessThan(expected * 1.5);
    });
});

describe('settings persistence', () => {
    it('round-trips through storage', () => {
        Gen.saveSettings({
            mode: 'words',
            characters: { ...DEFAULT_CHARACTER_OPTIONS, length: 33 },
            words: { ...DEFAULT_WORD_OPTIONS, wordCount: 7 },
        });
        const loaded = Gen.loadSettings();
        expect(loaded.mode).toBe('words');
        expect(loaded.characters.length).toBe(33);
        expect(loaded.words.wordCount).toBe(7);
    });

    it('falls back to defaults on corrupt or missing storage', () => {
        expect(Gen.loadSettings()).toEqual({
            mode: 'characters',
            characters: DEFAULT_CHARACTER_OPTIONS,
            words: DEFAULT_WORD_OPTIONS,
        });
        store.set('vigil-generator-settings', 'not json');
        expect(Gen.loadSettings().mode).toBe('characters');
    });
});

describe('generateFromSettings', () => {
    it('uses the saved character options', () => {
        Gen.saveSettings({
            mode: 'characters',
            characters: { ...digitsOnly, length: 12 },
            words: DEFAULT_WORD_OPTIONS,
        });
        expect(Gen.generateFromSettings()).toMatch(/^[0-9]{12}$/);
    });

    it('generates a passphrase when words mode is saved', () => {
        Gen.saveSettings({
            mode: 'words',
            characters: DEFAULT_CHARACTER_OPTIONS,
            words: { wordCount: 4, separator: '.', capitalize: false, includeNumber: false },
        });
        expect(Gen.generateFromSettings()).toMatch(/^[a-z]+(\.[a-z]+){3}$/);
    });

    it('recovers with defaults when the saved pool is empty', () => {
        Gen.saveSettings({
            mode: 'characters',
            characters: { ...digitsOnly, digits: false, length: 12 },
            words: DEFAULT_WORD_OPTIONS,
        });
        expect(Gen.generateFromSettings().length).toBe(DEFAULT_CHARACTER_OPTIONS.length);
    });
});

describe('browser generate-password', () => {
    it('answers with a password shaped by the saved settings', async () => {
        Gen.saveSettings({
            mode: 'characters',
            characters: { ...digitsOnly, length: 10 },
            words: DEFAULT_WORD_OPTIONS,
        });
        const result = await BrowserIntegrationService.handleRequest('generate-password', {}, {} as any);
        expect(result.password).toMatch(/^[0-9]{10}$/);
        expect(result.entries).toEqual([{ password: result.password }]);
    });
});

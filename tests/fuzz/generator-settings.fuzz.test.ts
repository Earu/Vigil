import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import {
    PasswordGeneratorService as Gen,
    DEFAULT_CHARACTER_OPTIONS,
    DEFAULT_WORD_OPTIONS,
} from '../../src/services/PasswordGeneratorService';
import { PassphraseService } from '../../src/services/PassphraseService';
import { settings, anyText, anyValue } from './fuzz';

// The generator's options are persisted in localStorage and read back into
// generation, including the browser extension's generate-password, which
// takes whatever is stored and hands the result to a site. Storage is not a
// trust boundary the way a socket is, but it is the one input to a password's
// entropy that nothing in the app validates on the way in: a cleared field,
// another version's format, or anything with write access to the profile.
// The floor asserted here is that a password comes back at all.

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
};

const STORAGE_KEY = 'vigil-generator-settings';

beforeAll(() => PassphraseService.preload());
beforeEach(() => store.clear());

// What a settings blob looks like when it is nearly right: the shape the app
// writes, with any one field replaced by something it never would
const storedSettings = (): fc.Arbitrary<unknown> => fc.oneof(
    { weight: 2, arbitrary: anyValue() },
    {
        weight: 3, arbitrary: fc.record({
            mode: fc.oneof(fc.constantFrom('characters', 'words'), anyText(), anyValue()),
            characters: fc.oneof(
                fc.record({ length: fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double(), fc.constant(null), anyText()) }, { requiredKeys: [] }),
                anyValue(),
            ),
            words: fc.oneof(
                fc.record({
                    wordCount: fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double(), fc.constant(null), anyText()),
                    separator: fc.oneof(anyText(), anyValue()),
                    capitalize: anyValue(),
                    includeNumber: anyValue(),
                }, { requiredKeys: [] }),
                anyValue(),
            ),
        }, { requiredKeys: [] }),
    },
);

describe('generator settings under fuzz', () => {
    it('anything stored loads as options inside the ranges the modal offers', () => {
        fc.assert(fc.property(storedSettings(), stored => {
            store.set(STORAGE_KEY, JSON.stringify(stored) ?? 'undefined');
            const loaded = Gen.loadSettings();

            expect(loaded.mode === 'characters' || loaded.mode === 'words').toBe(true);
            expect(Number.isInteger(loaded.characters.length)).toBe(true);
            expect(loaded.characters.length).toBeGreaterThanOrEqual(Gen.MIN_LENGTH);
            expect(loaded.characters.length).toBeLessThanOrEqual(Gen.MAX_LENGTH);
            expect(Number.isInteger(loaded.words.wordCount)).toBe(true);
            expect(loaded.words.wordCount).toBeGreaterThanOrEqual(PassphraseService.MIN_WORDS);
            expect(loaded.words.wordCount).toBeLessThanOrEqual(PassphraseService.MAX_WORDS);
        }), settings());
    });

    it('anything stored still generates a password, never an empty string', () => {
        fc.assert(fc.property(storedSettings(), stored => {
            store.set(STORAGE_KEY, JSON.stringify(stored) ?? 'undefined');
            const password = Gen.generateFromSettings();

            expect(typeof password).toBe('string');
            expect(password.length).toBeGreaterThan(0);
        }), settings());
    });

    it('a stored blob can never shorten a character password below the length it loads', () => {
        fc.assert(fc.property(storedSettings(), stored => {
            store.set(STORAGE_KEY, JSON.stringify({ ...(stored as object), mode: 'characters' }));
            const loaded = Gen.loadSettings();
            const password = Gen.generateFromSettings(loaded);
            // Astral characters from a custom set count as one each
            const drawn = [...password].length;
            const pool = Gen.characterPool(loaded.characters);
            expect(drawn).toBe(pool.length === 0 ? DEFAULT_CHARACTER_OPTIONS.length : loaded.characters.length);
        }), settings());
    });

    it('a stored blob can never shorten a passphrase below the words it loads', () => {
        fc.assert(fc.property(storedSettings(), stored => {
            store.set(STORAGE_KEY, JSON.stringify({ ...(stored as object), mode: 'words' }));
            const loaded = Gen.loadSettings();
            // The wordlist holds hyphenated words, so the separator a count
            // is read back with has to be one no word can contain
            const passphrase = Gen.generateFromSettings({ ...loaded, words: { ...loaded.words, separator: '|', includeNumber: false } });
            expect(passphrase.split('|')).toHaveLength(loaded.words.wordCount);
        }), settings());
    });

    it('options handed straight to generation, of any shape, still yield a password', () => {
        fc.assert(fc.property(
            fc.constantFrom('characters' as const, 'words' as const),
            anyValue(),
            anyValue(),
            (mode, characters, words) => {
                // Neither the extension nor the modal builds options this way;
                // the fallback is what has to hold when something does
                const password = Gen.generateFromSettings({ mode, characters, words } as never);
                expect(typeof password).toBe('string');
                expect(password.length).toBeGreaterThan(0);
            },
        ), settings());
    });

    it('the word count PassphraseService accepts is the count it returns', () => {
        fc.assert(fc.property(fc.integer({ min: -100, max: 100 }), wordCount => {
            let passphrase: string;
            try {
                passphrase = PassphraseService.generate({ ...DEFAULT_WORD_OPTIONS, wordCount, separator: '|' });
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect(wordCount < PassphraseService.MIN_WORDS || wordCount > PassphraseService.MAX_WORDS).toBe(true);
                return;
            }
            expect(passphrase.split('|')).toHaveLength(wordCount);
        }), settings());
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
    PasswordGeneratorService as Gen,
    DEFAULT_PASSWORD_OPTIONS,
    DEFAULT_PASSPHRASE_OPTIONS,
} from '../src/services/PasswordGeneratorService';
import { BrowserIntegrationService } from '../src/services/BrowserIntegrationService';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
};

beforeEach(() => store.clear());

const digitsOnly = {
    ...DEFAULT_PASSWORD_OPTIONS,
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

describe('settings persistence', () => {
    it('round-trips through storage', () => {
        Gen.saveSettings({
            mode: 'words',
            password: { ...DEFAULT_PASSWORD_OPTIONS, length: 33 },
            passphrase: { ...DEFAULT_PASSPHRASE_OPTIONS, wordCount: 7 },
        });
        const loaded = Gen.loadSettings();
        expect(loaded.mode).toBe('words');
        expect(loaded.password.length).toBe(33);
        expect(loaded.passphrase.wordCount).toBe(7);
    });

    it('falls back to defaults on corrupt or missing storage', () => {
        expect(Gen.loadSettings()).toEqual({
            mode: 'characters',
            password: DEFAULT_PASSWORD_OPTIONS,
            passphrase: DEFAULT_PASSPHRASE_OPTIONS,
        });
        store.set('vigil-generator-settings', 'not json');
        expect(Gen.loadSettings().mode).toBe('characters');
    });
});

describe('generateFromSettings', () => {
    it('uses the saved character options', () => {
        Gen.saveSettings({
            mode: 'characters',
            password: { ...digitsOnly, length: 12 },
            passphrase: DEFAULT_PASSPHRASE_OPTIONS,
        });
        expect(Gen.generateFromSettings()).toMatch(/^[0-9]{12}$/);
    });

    it('generates a passphrase when words mode is saved', () => {
        Gen.saveSettings({
            mode: 'words',
            password: DEFAULT_PASSWORD_OPTIONS,
            passphrase: { wordCount: 4, separator: '.', capitalize: false, includeNumber: false },
        });
        expect(Gen.generateFromSettings()).toMatch(/^[a-z]+(\.[a-z]+){3}$/);
    });

    it('recovers with defaults when the saved pool is empty', () => {
        Gen.saveSettings({
            mode: 'characters',
            password: { ...digitsOnly, digits: false, length: 12 },
            passphrase: DEFAULT_PASSPHRASE_OPTIONS,
        });
        expect(Gen.generateFromSettings().length).toBe(DEFAULT_PASSWORD_OPTIONS.length);
    });
});

describe('browser generate-password', () => {
    it('answers with a password shaped by the saved settings', async () => {
        Gen.saveSettings({
            mode: 'characters',
            password: { ...digitsOnly, length: 10 },
            passphrase: DEFAULT_PASSPHRASE_OPTIONS,
        });
        const result = await BrowserIntegrationService.handleRequest('generate-password', {}, {} as any);
        expect(result.password).toMatch(/^[0-9]{10}$/);
        expect(result.entries).toEqual([{ password: result.password }]);
    });
});

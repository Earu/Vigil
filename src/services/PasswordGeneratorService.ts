import { PassphraseService, PassphraseOptions } from './PassphraseService';

// Character-mode password generation plus persistence of the generator's
// settings, shared between the generator modal and browser integration's
// generate-password so the extension gets passwords shaped like the user's.

export interface PasswordOptions {
    length: number;
    upperCase: boolean;
    lowerCase: boolean;
    digits: boolean;
    special: boolean;
    brackets: boolean;
    space: boolean;
    minus: boolean;
    underline: boolean;
    latin1: boolean;
    customChars: string;
}

export type GeneratorMode = 'characters' | 'words';

export interface GeneratorSettings {
    mode: GeneratorMode;
    password: PasswordOptions;
    passphrase: PassphraseOptions;
}

const STORAGE_KEY = 'vigil-generator-settings';

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
    length: 20,
    upperCase: true,
    lowerCase: true,
    digits: true,
    special: true,
    brackets: false,
    space: false,
    minus: false,
    underline: false,
    latin1: false,
    customChars: '',
};

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
    wordCount: 5,
    separator: '-',
    capitalize: false,
    includeNumber: false,
};

export class PasswordGeneratorService {
    static characterPool(options: PasswordOptions): string {
        let chars = '';
        if (options.upperCase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (options.lowerCase) chars += 'abcdefghijklmnopqrstuvwxyz';
        if (options.digits) chars += '0123456789';
        if (options.special) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
        if (options.brackets) chars += '[]{}()<>';
        if (options.space) chars += ' ';
        if (options.minus) chars += '-';
        if (options.underline) chars += '_';
        if (options.latin1) chars += 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ';
        if (options.customChars) chars += options.customChars;
        return chars;
    }

    // Rejection sampling: bytes past the largest multiple of the pool size
    // are discarded so every character is equally likely
    static generate(options: PasswordOptions): string {
        const chars = this.characterPool(options);
        if (!chars) throw new Error('No character sets selected');
        const limit = 256 - (256 % chars.length);
        let password = '';
        while (password.length < options.length) {
            const bytes = crypto.getRandomValues(new Uint8Array(options.length * 2));
            for (const byte of bytes) {
                if (byte < limit && password.length < options.length) {
                    password += chars[byte % chars.length];
                }
            }
        }
        return password;
    }

    static loadSettings(): GeneratorSettings {
        const defaults: GeneratorSettings = {
            mode: 'characters',
            password: { ...DEFAULT_PASSWORD_OPTIONS },
            passphrase: { ...DEFAULT_PASSPHRASE_OPTIONS },
        };
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
            return {
                mode: stored.mode === 'words' ? 'words' : 'characters',
                password: { ...defaults.password, ...stored.password },
                passphrase: { ...defaults.passphrase, ...stored.passphrase },
            };
        } catch {
            return defaults;
        }
    }

    static saveSettings(settings: GeneratorSettings): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch {
            // storage unavailable; settings just aren't remembered
        }
    }

    // What the browser extension gets: the saved mode and options, with a
    // fallback to defaults if the saved character pool is somehow empty
    static generateFromSettings(settings: GeneratorSettings = this.loadSettings()): string {
        if (settings.mode === 'words') {
            return PassphraseService.generate(settings.passphrase);
        }
        try {
            return this.generate(settings.password);
        } catch {
            return this.generate(DEFAULT_PASSWORD_OPTIONS);
        }
    }
}

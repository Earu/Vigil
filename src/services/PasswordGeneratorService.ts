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
    characters: PasswordOptions;
    words: PassphraseOptions;
}

const STORAGE_KEY = 'vigil-generator-settings';

export const DEFAULT_CHARACTER_OPTIONS: PasswordOptions = {
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

export const DEFAULT_WORD_OPTIONS: PassphraseOptions = {
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
        // The sets overlap: brackets, minus and underline repeat characters
        // the special set already has, and custom characters can repeat
        // anything. A duplicate would make that character twice as likely, so
        // collapse them. Iterating the string yields code points rather than
        // UTF-16 units, which keeps astral custom characters intact
        return [...new Set([...chars])].join('');
    }

    // Rejection sampling: draws past the largest multiple of the pool size are
    // discarded so every character is equally likely. Draws are 32-bit because
    // the pool can exceed 256 characters once custom ones are added, and with
    // an 8-bit draw the rejection limit collapsed to zero and spun forever.
    // Characters are collected in an array rather than concatenated: string
    // length counts UTF-16 units, which would cut the count short by one for
    // every astral character drawn
    static generate(options: PasswordOptions): string {
        const pool = [...this.characterPool(options)];
        if (pool.length === 0) throw new Error('No character sets selected');
        const limit = Math.floor(0x100000000 / pool.length) * pool.length;
        const out: string[] = [];
        while (out.length < options.length) {
            const draws = crypto.getRandomValues(new Uint32Array(options.length * 2));
            for (const draw of draws) {
                if (draw < limit && out.length < options.length) {
                    out.push(pool[draw % pool.length]);
                }
            }
        }
        return out.join('');
    }

    static loadSettings(): GeneratorSettings {
        const defaults: GeneratorSettings = {
            mode: 'characters',
            characters: { ...DEFAULT_CHARACTER_OPTIONS },
            words: { ...DEFAULT_WORD_OPTIONS },
        };
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
            return {
                mode: stored.mode === 'words' ? 'words' : 'characters',
                characters: { ...defaults.characters, ...stored.characters },
                words: { ...defaults.words, ...stored.words },
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
            return PassphraseService.generate(settings.words);
        }
        try {
            return this.generate(settings.characters);
        } catch {
            return this.generate(DEFAULT_CHARACTER_OPTIONS);
        }
    }
}

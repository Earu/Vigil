import { EFF_WORDLIST } from '../data/effWordlist';

export interface PassphraseOptions {
    wordCount: number;
    separator: string;
    capitalize: boolean;
    includeNumber: boolean;
}

export class PassphraseService {
    static readonly WORDLIST_SIZE = EFF_WORDLIST.length;

    private static randomIndex(max: number): number {
        // rejection sampling to avoid modulo bias
        const limit = Math.floor(0x100000000 / max) * max;
        const buf = new Uint32Array(1);
        let value: number;
        do {
            crypto.getRandomValues(buf);
            value = buf[0];
        } while (value >= limit);
        return value % max;
    }

    static generate(options: PassphraseOptions): string {
        const words: string[] = [];
        for (let i = 0; i < options.wordCount; i++) {
            let word = EFF_WORDLIST[this.randomIndex(EFF_WORDLIST.length)];
            if (options.capitalize) {
                word = word.charAt(0).toUpperCase() + word.slice(1);
            }
            words.push(word);
        }
        if (options.includeNumber && words.length > 0) {
            const target = this.randomIndex(words.length);
            words[target] += String(this.randomIndex(10));
        }
        return words.join(options.separator);
    }

    static entropyBits(options: PassphraseOptions): number {
        let bits = options.wordCount * Math.log2(EFF_WORDLIST.length);
        if (options.includeNumber) {
            bits += Math.log2(options.wordCount * 10);
        }
        return Math.round(bits);
    }
}

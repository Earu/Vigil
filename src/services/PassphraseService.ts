export interface PassphraseOptions {
    wordCount: number;
    separator: string;
    capitalize: boolean;
    includeNumber: boolean;
}

export class PassphraseService {
    // EFF large wordlist size, fixed by the list itself
    static readonly WORDLIST_SIZE = 7776;

    // The wordlist is ~60 KB of the bundle and only matters in passphrase
    // mode, so it loads on demand (same pattern as zxcvbn in
    // HaveIBeenPwnedService). Generation stays sync once loaded; callers
    // await preload() before generating. A failed chunk load retries on the
    // next call
    private static wordlist: string[] | null = null;
    private static wordlistLoading: Promise<void> | null = null;

    static preload(): Promise<void> {
        if (!this.wordlistLoading) {
            this.wordlistLoading = import('../data/effWordlist').then(module => {
                this.wordlist = module.EFF_WORDLIST;
            });
            this.wordlistLoading.catch(() => { this.wordlistLoading = null; });
        }
        return this.wordlistLoading;
    }

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
        const wordlist = this.wordlist;
        if (!wordlist) throw new Error('Wordlist not loaded, call preload() first');
        const words: string[] = [];
        for (let i = 0; i < options.wordCount; i++) {
            let word = wordlist[this.randomIndex(wordlist.length)];
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
        let bits = options.wordCount * Math.log2(this.WORDLIST_SIZE);
        if (options.includeNumber) {
            bits += Math.log2(options.wordCount * 10);
        }
        return Math.round(bits);
    }
}

import type zxcvbnType from 'zxcvbn';
import { userSettingsService } from './UserSettingsService';
import { HibpBreach } from './BreachCheckService';

export class HaveIBeenPwnedService {
    private static readonly HIBP_API_URL = 'https://api.pwnedpasswords.com';

    // zxcvbn's dictionaries are ~800 KB of the bundle, about half of it.
    // Loaded on demand instead of at startup, so the unlock screen does not
    // pay for a strength meter the session may never open. App kicks the
    // load off shortly after first paint, so by the time someone reaches a
    // password field the estimator is almost always ready
    private static zxcvbn: typeof zxcvbnType | null = null;
    private static zxcvbnLoading: Promise<void> | null = null;

    public static preloadStrengthEstimator(): Promise<void> {
        if (!this.zxcvbnLoading) {
            this.zxcvbnLoading = import('zxcvbn').then(module => {
                this.zxcvbn = module.default;
            });
            // A failed chunk load retries on the next call
            this.zxcvbnLoading.catch(() => { this.zxcvbnLoading = null; });
        }
        return this.zxcvbnLoading;
    }

    // Range responses shared between passwords with the same 5-char hash
    // prefix (identical passwords across entries always share one). Bounded
    // by LRU eviction: a hit refreshes the key's recency (Map iteration is
    // insertion-ordered), an insert past the cap drops only the coldest
    // prefix, so a huge vault stays flat without ever dumping the whole cache
    private static rangeCache = new Map<string, Promise<string>>();
    private static readonly RANGE_CACHE_LIMIT = 512;

    // An unpadded range response has a size that is a deterministic function
    // of the prefix, so its length identifies the bucket to anyone watching
    // the connection even though TLS hides the path. A whole-vault sweep
    // leaks one bucket per distinct password that way, with the same byte
    // sizes every time. Padding fills the response with fake entries so the
    // length carries much less. The fakes come back with a count of 0 and
    // must be discarded (see isPasswordPwned)
    private static fetchRange(prefix: string): Promise<string> {
        const cached = this.rangeCache.get(prefix);
        if (cached) {
            // Re-insert so the key becomes the newest and evicts last
            this.rangeCache.delete(prefix);
            this.rangeCache.set(prefix, cached);
            return cached;
        }
        if (this.rangeCache.size >= this.RANGE_CACHE_LIMIT) {
            const oldest = this.rangeCache.keys().next().value;
            if (oldest !== undefined) this.rangeCache.delete(oldest);
        }
        const request = fetch(`${this.HIBP_API_URL}/range/${prefix}`, {
            headers: { 'Add-Padding': 'true' },
        }).then((response) => {
            if (!response.ok) {
                throw new Error('Failed to check password breach status');
            }
            return response.text();
        });
        // A failed fetch must not poison the cache
        request.catch(() => this.rangeCache.delete(prefix));
        this.rangeCache.set(prefix, request);
        return request;
    }

    /**
     * Checks if a password has been exposed in known data breaches
     * Uses k-Anonymity model to safely check passwords
     */
    public static async isPasswordPwned(password: string): Promise<{ isPwned: boolean; count: number }> {
        // Convert password string to ArrayBuffer
        const encoder = new TextEncoder();
        const data = encoder.encode(password);

        // Create SHA-1 hash using Web Crypto API
        const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);

        // Convert ArrayBuffer to hex string
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

        const prefix = hash.substring(0, 5).toUpperCase();
        const suffix = hash.substring(5).toUpperCase();

        try {
            const hashes = await this.fetchRange(prefix);
            const hashList = hashes.split('\n');

            for (const hashLine of hashList) {
                const [hashSuffix, countStr] = hashLine.split(':');
                if (hashSuffix.trim() !== suffix) continue;
                // A real record has been seen at least once. A count of 0
                // marks one of the fake entries the padding added, which the
                // API requires clients to drop; reporting it would show the
                // password as breached "0 times"
                const count = parseInt(countStr, 10);
                if (count > 0) {
                    return { isPwned: true, count };
                }
            }

            return { isPwned: false, count: 0 };
        } catch (error) {
            console.error('Error checking password breach status:', error);
            throw error;
        }
    }

    /**
     * Checks if an email address has been exposed in known data breaches.
     * Requires a HIBP API key. Returns null on failure (rate limit, network)
     * so callers can retry later instead of caching a false all-clear
     */
    public static async checkEmailBreaches(email: string): Promise<HibpBreach[] | null> {
        const apiKey = userSettingsService.getHibpApiKey();
        if (!apiKey) {
            return [];
        }

        try {
            return await window.electron?.checkEmailBreaches(email, apiKey) ?? [];
        } catch {
            return null;
        }
    }

    /**
     * Checks the strength of a password using zxcvbn.
     * Local and synchronous: use this for UI feedback instead of
     * checkPassword, which also hits the HIBP API.
     * Returns null while the estimator chunk is still loading (and starts
     * the load); callers show no rating rather than a made-up one.
     */
    public static checkPasswordStrength(password: string): {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    } | null {
        if (!this.zxcvbn) {
            void this.preloadStrengthEstimator();
            return null;
        }
        // zxcvbn cost grows superlinearly with length (130ms+ at 100 chars,
        // all on the UI thread). The score saturates at 4 well below 32
        // random characters, so longer input only burns CPU
        const result = this.zxcvbn(password.slice(0, 32));
        return {
            score: result.score, // 0-4 (0 = weak, 4 = strong)
            feedback: {
                warning: result.feedback.warning || '',
                suggestions: result.feedback.suggestions || []
            }
        };
    }

    /**
     * Checks if a password has been exposed in known data breaches and evaluates its strength
     * Uses k-Anonymity model to safely check passwords and zxcvbn for strength evaluation
     */
    public static async checkPassword(password: string): Promise<{
        isPwned: boolean;
        pwnedCount: number;
        strength: {
            score: number;
            feedback: {
                warning: string;
                suggestions: string[];
            };
        };
    }> {
        const [pwnedResult] = await Promise.all([
            this.isPasswordPwned(password),
            this.preloadStrengthEstimator()
        ]);
        // Non-null once the preload above has resolved. A failed chunk load
        // rejected the Promise.all instead, so the entry stays uncached and
        // the next sweep retries rather than recording a made-up strength
        const strengthResult = this.checkPasswordStrength(password)!;

        return {
            isPwned: pwnedResult.isPwned,
            pwnedCount: pwnedResult.count,
            strength: strengthResult
        };
    }
}
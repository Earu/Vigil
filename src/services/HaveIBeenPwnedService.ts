import zxcvbn from 'zxcvbn';
import { userSettingsService } from './UserSettingsService';
import { HibpBreach } from './BreachCheckService';

export class HaveIBeenPwnedService {
    private static readonly HIBP_API_URL = 'https://api.pwnedpasswords.com';

    // Range responses shared between passwords with the same 5-char hash
    // prefix (identical passwords across entries always share one). Bounded;
    // reset when full so memory stays flat on huge vaults
    private static rangeCache = new Map<string, Promise<string>>();
    private static readonly RANGE_CACHE_LIMIT = 512;

    private static fetchRange(prefix: string): Promise<string> {
        const cached = this.rangeCache.get(prefix);
        if (cached) return cached;
        if (this.rangeCache.size >= this.RANGE_CACHE_LIMIT) this.rangeCache.clear();
        const request = fetch(`${this.HIBP_API_URL}/range/${prefix}`).then((response) => {
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
                if (hashSuffix.trim() === suffix) {
                    const count = parseInt(countStr);
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
     */
    public static checkPasswordStrength(password: string): {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    } {
        // zxcvbn cost grows superlinearly with length (130ms+ at 100 chars,
        // all on the UI thread). The score saturates at 4 well below 32
        // random characters, so longer input only burns CPU
        const result = zxcvbn(password.slice(0, 32));
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
        const [pwnedResult, strengthResult] = await Promise.all([
            this.isPasswordPwned(password),
            Promise.resolve(this.checkPasswordStrength(password))
        ]);

        return {
            isPwned: pwnedResult.isPwned,
            pwnedCount: pwnedResult.count,
            strength: strengthResult
        };
    }
}
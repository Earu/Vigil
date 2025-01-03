import zxcvbn from 'zxcvbn';
import { userSettingsService } from './UserSettingsService';
import { HibpBreach } from './BreachCheckService';

export class HaveIBeenPwnedService {
    private static readonly HIBP_API_URL = 'https://api.pwnedpasswords.com';

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
            const response = await fetch(`${this.HIBP_API_URL}/range/${prefix}`);

            if (!response.ok) {
                throw new Error('Failed to check password breach status');
            }

            const hashes = await response.text();
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
     * Checks if an email address has been exposed in known data breaches
     * Requires a HIBP API key
     */
    public static async checkEmailBreaches(email: string): Promise<HibpBreach[]> {
        const apiKey = userSettingsService.getHibpApiKey();
        if (!apiKey) {
            return [];
        }

        try {
            return await window.electron?.checkEmailBreaches(email, apiKey) ?? [];
        } catch (error) {
            console.error('Error checking email breach status:', error);
            throw error;
        }
    }

    /**
     * Checks the strength of a password using zxcvbn
     */
    private static checkPasswordStrength(password: string): {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    } {
        const result = zxcvbn(password);
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
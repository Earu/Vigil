import { HaveIBeenPwnedService } from './HaveIBeenPwnedService';
import { Entry, Group } from '../types/database';
import { BreachStatusStore } from './BreachStatusStore';
import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';

export interface HibpBreach {
    Name: string;
    Title: string;
    Domain: string;
    BreachDate: string;
    AddedDate: string;
    ModifiedDate: string;
    PwnCount: number;
    Description: string;
    LogoPath: string;
    DataClasses: string[];
    IsVerified: boolean;
    IsFabricated: boolean;
    IsSensitive: boolean;
    IsRetired: boolean;
    IsSpamList: boolean;
    IsMalware: boolean;
    IsSubscriptionFree: boolean;
}

export interface PasswordStatus {
    isPwned: boolean;
    pwnedCount: number;
    strength: {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    };
}

export interface BreachedEntry {
    entry: Entry;
    group: Group;
    count: number;
    strength?: {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    };
}

export interface BreachCheckResult {
    breached: BreachedEntry[];
    weak: BreachedEntry[];
    hasCheckedEntries: boolean;
    allEntriesCached: boolean;
}

export interface EmailBreachResult {
    email: string;
    entryId: string;
    breaches: HibpBreach[];
}

export interface EmailCheckResult {
    checkedEmails: EmailBreachResult[];
    hasCheckedEmails: boolean;
    allEmailsCached: boolean;
}

export class BreachCheckService {
    // Rate limiting: max 1 request per 1.5 seconds for passwords
    private static readonly REQUEST_DELAY = 1500;
    // Rate limiting: max 10 requests per minute for emails
    private static readonly EMAIL_REQUEST_DELAY = 6000; // 6 seconds between requests
    private static readonly EMAIL_MAX_REQUESTS = 10;
    private static lastRequestTime = 0;
    private static lastEmailRequestTime = 0;
    private static emailRequestCount = 0;
    private static toastId: string | null = null;
    private static countedEntries: Set<string> = new Set();
    private static progress = { checked: 0, total: 0 };
    private static emailBreachCache: Map<string, { email: string, breaches: HibpBreach[], timestamp: number }> = new Map();
    private static readonly EMAIL_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

    private static async checkPassword(password: string | kdbxweb.ProtectedValue): Promise<PasswordStatus> {
        // Ensure we don't exceed rate limits
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.REQUEST_DELAY) {
            await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY - timeSinceLastRequest));
        }

        const passwordString = typeof password === 'string' ? password : password.getText();

        const result = await HaveIBeenPwnedService.checkPassword(passwordString);
        this.lastRequestTime = Date.now();
        return result;
    }

    private static countTotalEntries(group: Group): number {
        let total = group.entries.length;
        for (const subgroup of group.groups) {
            total += this.countTotalEntries(subgroup);
        }
        return total;
    }

    private static incrementProgress(entryId: string): void {
        if (!this.countedEntries.has(entryId)) {
            this.countedEntries.add(entryId);
            this.progress.checked++;
            this.updateToast(this.progress.checked, this.progress.total);
        }
    }

    private static updateToast(checked: number, total: number): void {
        if (total === 0) return;

        const message = `Checking passwords for breaches (${checked}/${total})`;
        if (this.toastId) {
            (window as any).updateToast?.(this.toastId, {
                message,
                type: 'info',
                duration: 0 // Keep it visible
            });
        } else {
            this.toastId = (window as any).showToast?.({
                message,
                type: 'info',
                duration: 0 // Keep it visible
            });
        }
    }

    public static async checkEntry(databasePath: string, entry: Entry): Promise<boolean> {
        // Check cache first
        const cachedStatus = BreachStatusStore.getEntryStatus(databasePath, entry.id);

        if (cachedStatus !== null) {
            this.incrementProgress(entry.id);
            return cachedStatus.isPwned;
        }

        // If not in cache or expired, check the password
        try {
            const result = await this.checkPassword(entry.password);
            BreachStatusStore.setEntryStatus(databasePath, entry.id, {
                isPwned: result.isPwned,
                count: result.pwnedCount,
                strength: result.strength
            });
            this.incrementProgress(entry.id);

            return result.isPwned;
        } catch (error) {
            // Don't cache errors - we want to retry later
            this.incrementProgress(entry.id);
            throw error;
        }
    }

    public static async checkGroup(databasePath: string, group: Group): Promise<boolean> {
        let hasBreached = false;
        const isRootGroup = group.name === 'All Entries';

        // Start checking status if this is the root call
        if (isRootGroup) {
            const totalEntries = this.countTotalEntries(group);
            this.countedEntries.clear();
            this.progress = { checked: 0, total: totalEntries };

            // Show initial toast immediately
            this.toastId = (window as any).showToast?.({
                message: `Starting password breach check (0/${totalEntries})`,
                type: 'info',
                duration: 0 // Keep it visible
            });
        }

        try {
            // Check entries one at a time to respect rate limits
            for (const entry of group.entries) {
                try {
                    const isBreached = await this.checkEntry(databasePath, entry);
                    hasBreached = hasBreached || isBreached;
                } catch (error) {
                    // Continue checking other entries even if one fails
                    console.error('Error checking entry:', error);
                }
            }

            // Check subgroups one at a time
            for (const subgroup of group.groups) {
                try {
                    const isBreached = await this.checkGroup(databasePath, subgroup);
                    hasBreached = hasBreached || isBreached;
                } catch (error) {
                    // Continue checking other groups even if one fails
                    console.error('Error checking group:', error);
                }
            }

            // Stop checking status if this is the root call
            if (isRootGroup) {
                this.countedEntries.clear();
                this.progress = { checked: 0, total: 0 };

                // Show completion toast
                if (this.toastId) {
                    (window as any).updateToast?.(this.toastId, {
                        message: 'Completed checking passwords for breaches',
                        type: 'success',
                        duration: 10000 // Show for 10 seconds then dismiss
                    });
                    this.toastId = null;
                }
            }

            return hasBreached;
        } catch (error) {
            // Make sure we stop the status if there's an error
            if (isRootGroup) {
                this.countedEntries.clear();
                this.progress = { checked: 0, total: 0 };

                // Show error toast
                if (this.toastId) {
                    (window as any).updateToast?.(this.toastId, {
                        message: 'Error checking passwords for breaches',
                        type: 'error',
                        duration: 3000 // Show for 3 seconds then dismiss
                    });
                    this.toastId = null;
                }
            }
            throw error;
        }
    }

    public static getEntryBreachStatus(databasePath: string, entryId: string): { isPwned: boolean; count: number } | null {
        return BreachStatusStore.getEntryStatus(databasePath, entryId);
    }

    public static clearCache(databasePath: string): void {
        BreachStatusStore.clearDatabase(databasePath);
    }

    /**
     * Finds breached and weak entries from the cache for a given group
     * @param group The group to check
     * @param parentGroup Optional parent group (defaults to the group itself)
     * @returns Object containing breached and weak entries, along with cache status
     */
    public static findBreachedAndWeakEntries(group: Group, parentGroup: Group = group): BreachCheckResult {
        const databasePath = KeepassDatabaseService.getPath();
        if (!databasePath) return {
            breached: [],
            weak: [],
            hasCheckedEntries: false,
            allEntriesCached: false
        };

        const breached: BreachedEntry[] = [];
        const weak: BreachedEntry[] = [];
        let hasCheckedEntries = false;
        let allEntriesCached = true;

        // Check entries in current group
        group.entries.forEach(entry => {
            const status = BreachStatusStore.getEntryStatus(databasePath, entry.id);
            hasCheckedEntries = true;

            if (status === null) {
                allEntriesCached = false;
                return;
            }

            const entryInfo = {
                entry,
                group: parentGroup,
                count: status.count,
                strength: status.strength
            };

            if (status.isPwned) {
                breached.push(entryInfo);
            }

            if (status.strength && status.strength.score < 3) {
                weak.push(entryInfo);
            }
        });

        // Check subgroups
        group.groups.forEach(subgroup => {
            const subResults = this.findBreachedAndWeakEntries(subgroup, subgroup);
            breached.push(...subResults.breached);
            weak.push(...subResults.weak);
            hasCheckedEntries = hasCheckedEntries || subResults.hasCheckedEntries;
            allEntriesCached = allEntriesCached && subResults.allEntriesCached;
        });

        return {
            breached,
            weak,
            hasCheckedEntries,
            allEntriesCached
        };
    }

    /**
     * Checks if a group has any weak passwords
     * @param group The group to check
     * @returns boolean indicating if the group has any weak passwords
     */
    public static hasWeakPasswords(group: Group): boolean {
        const databasePath = KeepassDatabaseService.getPath();
        if (!databasePath) return false;

        const hasWeakPassword = group.entries.some(entry => {
            const status = BreachStatusStore.getEntryStatus(databasePath, entry.id);
            return status?.strength && status.strength.score < 3;
        });

        if (hasWeakPassword) return true;

        return group.groups.some(subgroup => this.hasWeakPasswords(subgroup));
    }

    private static isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    private static async checkEmailForEntry(email: string, entryId: string, modifiedDate: Date): Promise<HibpBreach[]> {
        // Check cache first
        const cached = this.emailBreachCache.get(entryId);
        if (cached && cached.email === email && (Date.now() - cached.timestamp) < this.EMAIL_CACHE_DURATION) {
            return cached.breaches;
        }

        // Get breaches from shared cache or make request
        const breaches = await this.getEmailBreaches(email);

        // Filter breaches based on entry modification date
        const recentBreaches = breaches.filter(breach => {
            const breachDate = new Date(breach.ModifiedDate).getTime();
            return breachDate > modifiedDate.getTime();
        });

        // Update cache
        this.emailBreachCache.set(entryId, {
            email,
            breaches: recentBreaches,
            timestamp: Date.now()
        });

        return recentBreaches;
    }

    private static emailBreachRequests = new Map<string, Promise<HibpBreach[]>>();

    private static async getEmailBreaches(email: string): Promise<HibpBreach[]> {
        // Check if we already have a pending request for this email
        const pendingRequest = this.emailBreachRequests.get(email);
        if (pendingRequest) {
            return pendingRequest;
        }

        // Reset request count if it's been more than a minute
        const now = Date.now();
        if (now - this.lastEmailRequestTime > 60000) {
            this.emailRequestCount = 0;
        }

        // Check rate limits
        if (this.emailRequestCount >= this.EMAIL_MAX_REQUESTS) {
            throw new Error('Email check rate limit exceeded. Please try again later.');
        }

        const timeSinceLastRequest = now - this.lastEmailRequestTime;
        if (timeSinceLastRequest < this.EMAIL_REQUEST_DELAY) {
            await new Promise(resolve => setTimeout(resolve, this.EMAIL_REQUEST_DELAY - timeSinceLastRequest));
        }

        // Create new request promise
        const breachPromise = (async () => {
            try {
                const breaches = await HaveIBeenPwnedService.checkEmailBreaches(email);

                // Update rate limiting
                this.lastEmailRequestTime = Date.now();
                this.emailRequestCount++;

                return breaches;
            } catch (error) {
                console.error('Error checking email breaches:', error);
                throw error;
            } finally {
                // Clean up the request from the map
                this.emailBreachRequests.delete(email);
            }
        })();

        // Store the promise in the map
        this.emailBreachRequests.set(email, breachPromise);

        return breachPromise;
    }

    public static async checkEmails(group: Group): Promise<EmailCheckResult> {
        const checkedEmails: EmailBreachResult[] = [];
        let hasCheckedEmails = false;
        let allEmailsCached = true;

        // Helper function to check emails in a group
        const checkGroupEmails = async (group: Group) => {
            for (const entry of group.entries) {
                if (entry.username && this.isValidEmail(entry.username)) {
                    try {
                        const breaches = await this.checkEmailForEntry(entry.username, entry.id, entry.modified);
                        if (breaches.length > 0) {
                            checkedEmails.push({
                                email: entry.username,
                                entryId: entry.id,
                                breaches
                            });
                            hasCheckedEmails = true;
                        }
                    } catch (error) {
                        console.error(`Error checking email for entry ${entry.id}:`, error);
                        allEmailsCached = false;
                    }
                }
            }

            // Check subgroups
            for (const subgroup of group.groups) {
                await checkGroupEmails(subgroup);
            }
        };

        try {
            await checkGroupEmails(group);
            return {
                checkedEmails,
                hasCheckedEmails,
                allEmailsCached
            };
        } catch (error) {
            console.error('Error checking emails:', error);
            throw error;
        }
    }

    public static clearEmailCache(): void {
        this.emailBreachCache.clear();
    }
}
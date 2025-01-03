import { HaveIBeenPwnedService } from './HaveIBeenPwnedService';
import { Entry, Group } from '../types/database';
import { BreachStatusStore } from './BreachStatusStore';
import { EmailBreachStatusStore } from './EmailBreachStatusStore';
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

export interface BreachedEmailEntry extends BreachedEntry {
    breaches: HibpBreach[];
    modified: Date;
}

export interface EmailBreachCheckResult {
    breached: BreachedEmailEntry[];
    hasCheckedEmails: boolean;
    allEmailsCached: boolean;
}

export class BreachCheckService {
    // Rate limiting: max 1 request per 1.5 seconds for passwords
    private static readonly REQUEST_DELAY = 1500;
    private static lastRequestTime = 0;
    private static countedEntries: Set<string> = new Set();
    private static progress = { checked: 0, total: 0 };

    // Rate limiting: max 10 requests per minute for emails
    private static readonly EMAIL_REQUEST_DELAY = 6000; // 6 seconds between requests
    private static lastEmailRequestTime = 0;
    private static countedEmails: Set<string> = new Set();
    private static emailProgress = { checked: 0, total: 0 };

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
            }

            return hasBreached;
        } catch (error) {
            // Make sure we stop the status if there's an error
            if (isRootGroup) {
                this.countedEntries.clear();
                this.progress = { checked: 0, total: 0 };
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

    private static incrementEmailProgress(entryId: string): void {
        if (!this.countedEmails.has(entryId)) {
            this.countedEmails.add(entryId);
            this.emailProgress.checked++;
        }
    }

    private static async checkEmailEntry(databasePath: string, entry: Entry): Promise<HibpBreach[]> {
        if (!this.isValidEmail(entry.username)) {
            return [];
        }

        // Check cache first
        const cachedStatus = EmailBreachStatusStore.getEntryEmailStatus(databasePath, entry.id, entry.username);

        if (cachedStatus !== null) {
            this.incrementEmailProgress(entry.id);
            return cachedStatus;
        }

        // Ensure we don't exceed rate limits
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastEmailRequestTime;
        if (timeSinceLastRequest < this.EMAIL_REQUEST_DELAY) {
            await new Promise(resolve => setTimeout(resolve, this.EMAIL_REQUEST_DELAY - timeSinceLastRequest));
        }

        try {
            const breaches = await HaveIBeenPwnedService.checkEmailBreaches(entry.username);
            EmailBreachStatusStore.setEntryEmailStatus(databasePath, entry.id, entry.username, breaches);
            this.lastEmailRequestTime = Date.now();
            this.incrementEmailProgress(entry.id);
            return breaches;
        } catch (error) {
            // Don't cache errors - we want to retry later
            this.incrementEmailProgress(entry.id);
            throw error;
        }
    }

    public static async checkGroupEmails(databasePath: string, group: Group): Promise<boolean> {
        let hasBreached = false;
        const isRootGroup = group.name === 'All Entries';

        // Start checking status if this is the root call
        if (isRootGroup) {
            const totalEntries = this.countTotalEntries(group);
            this.countedEmails.clear();
            this.emailProgress = { checked: 0, total: totalEntries };
        }

        try {
            // Check entries one at a time to respect rate limits
            for (const entry of group.entries) {
                if (this.isValidEmail(entry.username)) {
                    try {
                        const breaches = await this.checkEmailEntry(databasePath, entry);
                        hasBreached = hasBreached || breaches.length > 0;
                    } catch (error) {
                        // Continue checking other entries even if one fails
                        console.error('Error checking email entry:', error);
                    }
                } else {
                    // Skip non-email entries but still count them for progress
                    this.incrementEmailProgress(entry.id);
                }
            }

            // Check subgroups one at a time
            for (const subgroup of group.groups) {
                try {
                    const isBreached = await this.checkGroupEmails(databasePath, subgroup);
                    hasBreached = hasBreached || isBreached;
                } catch (error) {
                    // Continue checking other groups even if one fails
                    console.error('Error checking group:', error);
                }
            }

            // Stop checking status if this is the root call
            if (isRootGroup) {
                this.countedEmails.clear();
                this.emailProgress = { checked: 0, total: 0 };
            }

            return hasBreached;
        } catch (error) {
            // Make sure we stop the status if there's an error
            if (isRootGroup) {
                this.countedEmails.clear();
                this.emailProgress = { checked: 0, total: 0 };
            }
            throw error;
        }
    }

    public static findBreachedEmails(group: Group, parentGroup: Group = group): EmailBreachCheckResult {
        const databasePath = KeepassDatabaseService.getPath();
        if (!databasePath) return {
            breached: [],
            hasCheckedEmails: false,
            allEmailsCached: false
        };

        const breached: BreachedEmailEntry[] = [];
        let hasCheckedEmails = false;
        let allEmailsCached = true;

        // Check entries in current group
        group.entries.forEach(entry => {
            if (!this.isValidEmail(entry.username)) {
                return;
            }

            const breaches = EmailBreachStatusStore.getEntryEmailStatus(databasePath, entry.id, entry.username);
            hasCheckedEmails = true;

            if (breaches === null) {
                allEmailsCached = false;
                return;
            }

            if (breaches.length > 0) {
                const entryInfo: BreachedEmailEntry = {
                    entry,
                    group: parentGroup,
                    count: breaches.length,
                    breaches,
                    modified: entry.modified
                };

                // Check if any breach is newer than the entry's last modification
                const hasRecentBreach = breaches.some(breach => {
                    const breachDate = new Date(breach.BreachDate);
                    return breachDate > entry.modified;
                });

                if (hasRecentBreach) {
                    breached.push(entryInfo);
                }
            }
        });

        // Check subgroups
        group.groups.forEach(subgroup => {
            const subResults = this.findBreachedEmails(subgroup, subgroup);
            breached.push(...subResults.breached);
            hasCheckedEmails = hasCheckedEmails || subResults.hasCheckedEmails;
            allEmailsCached = allEmailsCached && subResults.allEmailsCached;
        });

        return {
            breached,
            hasCheckedEmails,
            allEmailsCached
        };
    }
}
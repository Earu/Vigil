import { HaveIBeenPwnedService } from './HaveIBeenPwnedService';
import { Entry, Group } from '../types/database';
import { BreachStatusStore } from './BreachStatusStore';
import * as kdbxweb from 'kdbxweb';

export class BreachCheckService {
    // Rate limiting: max 1 request per 1.5 seconds
    private static readonly REQUEST_DELAY = 1500;
    private static lastRequestTime = 0;
    private static toastId: string | null = null;
    private static countedEntries: Set<string> = new Set();
    private static progress = { checked: 0, total: 0 };

    private static async checkPassword(password: string | kdbxweb.ProtectedValue): Promise<{ isPwned: boolean; count: number }> {
        // Ensure we don't exceed rate limits
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.REQUEST_DELAY) {
            await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY - timeSinceLastRequest));
        }

        const passwordString = typeof password === 'string' ? password : password.getText();

        const result = await HaveIBeenPwnedService.isPasswordPwned(passwordString);
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
            BreachStatusStore.setEntryStatus(databasePath, entry.id, result);
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
}
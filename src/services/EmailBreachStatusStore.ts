import { HibpBreach } from './BreachCheckService';

interface EmailBreachStatus {
    breaches: HibpBreach[];
    timestamp: number;
}

interface EntryEmailBreachStatus {
    [entryId: string]: EmailBreachStatus;
}

interface EmailBreachCache {
    [email: string]: EmailBreachStatus;
}

interface DatabaseEmailBreachStatus {
    [databasePath: string]: {
        entries: EntryEmailBreachStatus;
        emails: EmailBreachCache;
    };
}

export class EmailBreachStatusStore {
    private static readonly STORE_KEY = 'email_breach_status_store';
    private static readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    private static getStore(): DatabaseEmailBreachStatus {
        const stored = localStorage.getItem(this.STORE_KEY);
        if (!stored) return {};
        return JSON.parse(stored);
    }

    private static saveStore(store: DatabaseEmailBreachStatus): void {
        localStorage.setItem(this.STORE_KEY, JSON.stringify(store));
    }

    private static initializeDatabase(store: DatabaseEmailBreachStatus, databasePath: string): void {
        if (!store[databasePath]) {
            store[databasePath] = {
                entries: {},
                emails: {}
            };
        }
    }

    private static isStatusExpired(status: EmailBreachStatus): boolean {
        return Date.now() - status.timestamp > this.CACHE_DURATION;
    }

    public static setEntryEmailStatus(databasePath: string, entryId: string, email: string, breaches: HibpBreach[]): void {
        const store = this.getStore();
        this.initializeDatabase(store, databasePath);

        const status: EmailBreachStatus = {
            breaches,
            timestamp: Date.now()
        };

        // Store the result both by entry and by email
        store[databasePath].entries[entryId] = status;
        store[databasePath].emails[email] = status;

        this.saveStore(store);
    }

    public static getEntryEmailStatus(databasePath: string, entryId: string, email: string): HibpBreach[] | null {
        const store = this.getStore();
        const database = store[databasePath];
        if (!database) return null;

        // First, check if we have a cached result for this email
        const emailStatus = database.emails[email];
        if (emailStatus && !this.isStatusExpired(emailStatus)) {
            // If we have a valid email cache, update the entry cache too
            database.entries[entryId] = emailStatus;
            this.saveStore(store);
            return emailStatus.breaches;
        }

        // If no email cache, check entry cache
        const entryStatus = database.entries[entryId];
        if (!entryStatus || this.isStatusExpired(entryStatus)) {
            return null;
        }

        return entryStatus.breaches;
    }

    public static clearDatabase(databasePath: string): void {
        const store = this.getStore();
        delete store[databasePath];
        this.saveStore(store);
    }

    public static clearAll(): void {
        localStorage.removeItem(this.STORE_KEY);
    }

    public static clearStatus(databasePath: string, entryId: string): void {
        const store = this.getStore();
        if (store[databasePath]?.entries) {
            delete store[databasePath].entries[entryId];
            if (Object.keys(store[databasePath].entries).length === 0 &&
                Object.keys(store[databasePath].emails).length === 0) {
                delete store[databasePath];
            }
            this.saveStore(store);
        }
    }

    public static clearEmailStatus(databasePath: string, email: string): void {
        const store = this.getStore();
        if (store[databasePath]?.emails) {
            delete store[databasePath].emails[email];
            if (Object.keys(store[databasePath].entries).length === 0 &&
                Object.keys(store[databasePath].emails).length === 0) {
                delete store[databasePath];
            }
            this.saveStore(store);
        }
    }
}
export interface PasswordStrength {
    score: number;
    feedback: {
        warning: string;
        suggestions: string[];
    };
}

interface BreachStatus {
    isPwned: boolean;
    count: number;
    strength: PasswordStrength;
    timestamp: number;
    breachedEmail?: boolean;
}

interface EntryBreachStatus {
    [entryId: string]: BreachStatus;
}

interface DatabaseBreachStatus {
    [databasePath: string]: EntryBreachStatus;
}

export class BreachStatusStore {
    private static readonly STORE_KEY = 'breach_status_store';
    private static readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    private static getStore(): DatabaseBreachStatus {
        const stored = localStorage.getItem(this.STORE_KEY);
        if (!stored) return {};
        return JSON.parse(stored);
    }

    private static saveStore(store: DatabaseBreachStatus): void {
        localStorage.setItem(this.STORE_KEY, JSON.stringify(store));
    }

    public static setEntryStatus(databasePath: string, entryId: string, status: { isPwned: boolean; count: number; strength: PasswordStrength; breachedEmail?: boolean }): void {
        const store = this.getStore();
        if (!store[databasePath]) {
            store[databasePath] = {};
        }

        store[databasePath][entryId] = {
            ...status,
            timestamp: Date.now()
        };

        this.saveStore(store);
    }

    public static getEntryStatus(databasePath: string, entryId: string): { isPwned: boolean; count: number; strength: PasswordStrength; breachedEmail?: boolean } | null {
        const store = this.getStore();
        const status = store[databasePath]?.[entryId];

        if (!status) {
            return null;
        }

        if (Date.now() - status.timestamp > this.CACHE_DURATION) {
            this.clearStatus(databasePath, entryId);
            return null;
        }

        const { isPwned, count, strength, breachedEmail } = status;
        return { isPwned, count, strength, breachedEmail };
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
        if (store[databasePath]) {
            delete store[databasePath][entryId];
            if (Object.keys(store[databasePath]).length === 0) {
                delete store[databasePath];
            }
            this.saveStore(store);
        }
    }
}
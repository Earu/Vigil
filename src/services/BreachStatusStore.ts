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
    // null: no password to rate (passkey-only entries)
    strength: PasswordStrength | null;
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

    // localStorage is only read once; all lookups hit this in-memory copy
    private static store: DatabaseBreachStatus | null = null;
    private static version = 0;
    private static listeners = new Set<() => void>();

    // Stable references for useSyncExternalStore
    public static subscribe = (listener: () => void): (() => void) => {
        BreachStatusStore.listeners.add(listener);
        return () => BreachStatusStore.listeners.delete(listener);
    };

    public static getVersion = (): number => BreachStatusStore.version;

    private static getStore(): DatabaseBreachStatus {
        if (this.store === null) {
            const stored = localStorage.getItem(this.STORE_KEY);
            this.store = stored ? JSON.parse(stored) : {};
        }
        return this.store!;
    }

    private static saveStore(): void {
        localStorage.setItem(this.STORE_KEY, JSON.stringify(this.getStore()));
        this.version++;
        this.listeners.forEach(listener => listener());
    }

    public static setEntryStatus(databasePath: string, entryId: string, status: { isPwned: boolean; count: number; strength: PasswordStrength | null; breachedEmail?: boolean }): void {
        const store = this.getStore();
        if (!store[databasePath]) {
            store[databasePath] = {};
        }

        store[databasePath][entryId] = {
            ...status,
            timestamp: Date.now()
        };

        this.saveStore();
    }

    public static getEntryStatus(databasePath: string, entryId: string): { isPwned: boolean; count: number; strength: PasswordStrength | null; breachedEmail?: boolean } | null {
        const status = this.getStore()[databasePath]?.[entryId];

        if (!status) {
            return null;
        }

        // Expired entries are treated as absent; the next background check
        // overwrites them. No write here: this runs during render.
        if (Date.now() - status.timestamp > this.CACHE_DURATION) {
            return null;
        }

        const { isPwned, count, strength, breachedEmail } = status;
        return { isPwned, count, strength, breachedEmail };
    }

    public static clearDatabase(databasePath: string): void {
        const store = this.getStore();
        delete store[databasePath];
        this.saveStore();
    }

    public static clearAll(): void {
        this.store = {};
        localStorage.removeItem(this.STORE_KEY);
        this.version++;
        this.listeners.forEach(listener => listener());
    }

    public static clearStatus(databasePath: string, entryId: string): void {
        const store = this.getStore();
        if (store[databasePath]) {
            delete store[databasePath][entryId];
            if (Object.keys(store[databasePath]).length === 0) {
                delete store[databasePath];
            }
            this.saveStore();
        }
    }
}

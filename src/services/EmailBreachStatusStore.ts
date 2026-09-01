import { HibpBreach } from './BreachCheckService';
import { BreachCacheCrypto } from './BreachCacheCrypto';

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
    // Sealed under a key only an open vault can derive; see BreachCacheCrypto
    private static readonly STORE_NAME = 'email-breach';
    private static readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    // Same coalescing as BreachStatusStore. It matters far less here (the HIBP
    // account API is rate limited to one lookup every few seconds, so writes
    // are rare), but the two stores drive the same indicators and diverging
    // write behaviour between them is only a trap for later
    private static readonly COALESCE_MS = 250;

    // Decrypted once per vault; all lookups hit this in-memory copy
    private static store: DatabaseEmailBreachStatus | null = null;
    // Which unlock the in-memory copy belongs to
    private static storeEpoch = -1;
    private static version = 0;
    private static listeners = new Set<() => void>();
    private static coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    private static pending = false;

    // Stable references for useSyncExternalStore
    public static subscribe = (listener: () => void): (() => void) => {
        EmailBreachStatusStore.listeners.add(listener);
        return () => EmailBreachStatusStore.listeners.delete(listener);
    };

    public static getVersion = (): number => EmailBreachStatusStore.version;

    // A vault opening or closing invalidates the copy: it belongs to whatever
    // was unlocked at the time, and nothing else can decrypt it anyway
    private static getStore(): DatabaseEmailBreachStatus {
        if (this.store === null || this.storeEpoch !== BreachCacheCrypto.epoch) {
            this.store = BreachCacheCrypto.read<DatabaseEmailBreachStatus>(this.STORE_NAME) ?? {};
            this.storeEpoch = BreachCacheCrypto.epoch;
        }
        return this.store;
    }

    private static persist(): void {
        this.cancelPending();
        BreachCacheCrypto.write(this.STORE_NAME, this.getStore());
        this.version++;
        this.listeners.forEach(listener => listener());
    }

    private static cancelPending(): void {
        if (this.coalesceTimer) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = null;
        }
        this.pending = false;
    }

    private static markChanged(): void {
        this.pending = true;
        if (this.coalesceTimer) return;
        this.coalesceTimer = setTimeout(() => {
            this.coalesceTimer = null;
            this.persist();
        }, this.COALESCE_MS);
    }

    public static flush(): void {
        if (this.pending) this.persist();
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

        this.markChanged();
    }

    public static getEntryEmailStatus(databasePath: string, entryId: string, email: string): HibpBreach[] | null {
        const database = this.getStore()[databasePath];
        if (!database) return null;

        // First, check if we have a cached result for this email.
        // Read-only: this runs during render, so no write-back here.
        const emailStatus = database.emails[email];
        if (emailStatus && !this.isStatusExpired(emailStatus)) {
            return emailStatus.breaches;
        }

        // If no email cache, check entry cache
        const entryStatus = database.entries[entryId];
        if (!entryStatus || this.isStatusExpired(entryStatus)) {
            return null;
        }

        return entryStatus.breaches;
    }

    // User or lifecycle driven, so these write through immediately
    public static clearDatabase(databasePath: string): void {
        const store = this.getStore();
        delete store[databasePath];
        this.persist();
    }

    public static clearAll(): void {
        this.cancelPending();
        this.store = {};
        this.storeEpoch = BreachCacheCrypto.epoch;
        BreachCacheCrypto.removeAllFor(this.STORE_NAME);
        this.version++;
        this.listeners.forEach(listener => listener());
    }

    public static clearStatus(databasePath: string, entryId: string): void {
        const store = this.getStore();
        if (store[databasePath]?.entries) {
            delete store[databasePath].entries[entryId];
            if (Object.keys(store[databasePath].entries).length === 0 &&
                Object.keys(store[databasePath].emails).length === 0) {
                delete store[databasePath];
            }
            this.persist();
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
            this.persist();
        }
    }
}

// A window can be closed or hidden mid-sweep; do not let a coalesced write
// die with it. pagehide is not guaranteed when the renderer is torn down
// abruptly, so visibilitychange carries the weight: minimising, switching
// workspace and closing all fire it, and acting on it costs one write
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => EmailBreachStatusStore.flush());
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') EmailBreachStatusStore.flush();
    });
}

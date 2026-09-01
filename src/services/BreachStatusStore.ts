import { BreachCacheCrypto } from './BreachCacheCrypto';

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
    // Sealed under a key only an open vault can derive; see BreachCacheCrypto
    private static readonly STORE_NAME = 'breach';
    private static readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    // A breach sweep writes one status per entry. Persisting and notifying on
    // each one is quadratic: the whole store is re-serialized every time, and
    // every subscriber re-walks the entry tree. These drive background
    // indicators, so coalescing a quarter second of them costs nothing
    private static readonly COALESCE_MS = 250;

    // Decrypted once per vault; all lookups hit this in-memory copy
    private static store: DatabaseBreachStatus | null = null;
    // Which unlock the in-memory copy belongs to
    private static storeEpoch = -1;
    private static version = 0;
    private static listeners = new Set<() => void>();
    private static coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    private static pending = false;

    // Stable references for useSyncExternalStore
    public static subscribe = (listener: () => void): (() => void) => {
        BreachStatusStore.listeners.add(listener);
        return () => BreachStatusStore.listeners.delete(listener);
    };

    public static getVersion = (): number => BreachStatusStore.version;

    // A vault opening or closing invalidates the copy: it belongs to whatever
    // was unlocked at the time, and nothing else can decrypt it anyway
    private static getStore(): DatabaseBreachStatus {
        if (this.store === null || this.storeEpoch !== BreachCacheCrypto.epoch) {
            this.store = BreachCacheCrypto.read<DatabaseBreachStatus>(this.STORE_NAME) ?? {};
            this.storeEpoch = BreachCacheCrypto.epoch;
        }
        return this.store;
    }

    // Write and notify in one step. The version bump rides with the
    // notification so a subscriber never sees a new snapshot without being
    // told about it
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

    // Force a coalesced write out now: a sweep finished, the vault locked, or
    // the window is going away. Losing one costs repeat HIBP lookups rather
    // than correctness, but there is no reason to pay that
    public static flush(): void {
        if (this.pending) this.persist();
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

        this.markChanged();
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

    // The clears below are user or lifecycle driven rather than part of a
    // sweep, so they write through immediately: "clear cache" has to survive
    // the app being closed a moment later
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
        if (store[databasePath]) {
            delete store[databasePath][entryId];
            if (Object.keys(store[databasePath]).length === 0) {
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
    window.addEventListener('pagehide', () => BreachStatusStore.flush());
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') BreachStatusStore.flush();
    });
}

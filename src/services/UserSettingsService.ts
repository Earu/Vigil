export type Theme = 'dark' | 'light' | 'system';

export interface HardwareKeyPreference {
    serial: number | null;
    slot: 1 | 2;
}

interface UserSettings {
    theme: Theme;
    hibpApiKey?: string;
    autoLockEnabled: boolean;
    autoLockDuration: number;
    // Remembered key file path per database path. Only paths are stored,
    // never key material
    keyFilePaths?: Record<string, string>;
    // Remembered hardware key (YubiKey challenge-response) per database path
    hardwareKeys?: Record<string, HardwareKeyPreference>;
    // Fetching entry icons from Google's favicon service sends each entry's
    // domain to Google, so it is opt-in
    fetchFavicons?: boolean;
    // WebAuthn treats localhost as a secure context, but serving passkeys to
    // arbitrary local processes is opt-in (matches KeePassXC's setting)
    allowPasskeysLocalhost?: boolean;
    // Skips the per-entry access confirmation on get-logins (matches
    // KeePassXC's "always allow access to entries"). Off by default: with it
    // on, an association key alone reads credentials. Entries with a
    // remembered refusal stay withheld either way
    alwaysAllowBrowserAccess?: boolean;
    // Copies of the vault kept before it is overwritten. On by default: the
    // save path merges external changes, and a merge that resolves badly
    // would otherwise take the only copy with it
    backupsEnabled?: boolean;
    backupKeep?: number;
    // How long a copied secret stays in the clipboard before it is wiped
    clipboardClearSeconds?: number;
    // Names this installation in the history notes written into a vault; see
    // HistoryNotesService. Random and opaque on purpose: it is written into a
    // file that gets synced and shared, so it must say nothing about the
    // machine or the person using it
    replicaId?: string;
}

export const MIN_BACKUP_KEEP = 1;
export const MAX_BACKUP_KEEP = 20;

export const DEFAULT_CLIPBOARD_CLEAR_SECONDS = 20;
export const MIN_CLIPBOARD_CLEAR_SECONDS = 5;
export const MAX_CLIPBOARD_CLEAR_SECONDS = 600;

const SETTINGS_KEY = 'vigil_user_settings';

class UserSettingsService {
    // Loaded on first access so importing this module never touches
    // localStorage (it is absent in the test environment)
    private settings: UserSettings | null = null;
    private version = 0;
    private listeners = new Set<() => void>();

    private get current(): UserSettings {
        if (!this.settings) this.settings = this.loadSettings();
        return this.settings;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => {
        return this.version;
    };

    private loadSettings(): UserSettings {
        try {
            const savedSettings = localStorage.getItem(SETTINGS_KEY);
            if (savedSettings) {
                return JSON.parse(savedSettings);
            }
        } catch { /* storage unavailable; use defaults */ }

        // Defaults for a fresh install only: anything already in storage is
        // returned above untouched, so this never overrides an existing choice
        return {
            theme: 'dark',
            hibpApiKey: undefined,
            // A vault that never locks is the wrong default for a password manager
            autoLockEnabled: true,
            autoLockDuration: 20
        };
    }

    private saveSettings(): void {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.current));
        } catch { /* storage unavailable */ }
        this.version++;
        this.listeners.forEach(listener => listener());
    }

    getFetchFavicons(): boolean {
        return this.current.fetchFavicons ?? false;
    }

    setFetchFavicons(enabled: boolean): void {
        this.current.fetchFavicons = enabled;
        this.saveSettings();
    }

    getBackupOptions(): { enabled: boolean; keep: number } {
        return {
            enabled: this.current.backupsEnabled ?? true,
            keep: this.current.backupKeep ?? 5,
        };
    }

    setBackupsEnabled(enabled: boolean): void {
        this.current.backupsEnabled = enabled;
        this.saveSettings();
    }

    setBackupKeep(keep: number): void {
        this.current.backupKeep = Math.min(MAX_BACKUP_KEEP, Math.max(MIN_BACKUP_KEEP, Math.round(keep)));
        this.saveSettings();
    }

    getClipboardClearSeconds(): number {
        return this.current.clipboardClearSeconds ?? DEFAULT_CLIPBOARD_CLEAR_SECONDS;
    }

    setClipboardClearSeconds(seconds: number): void {
        this.current.clipboardClearSeconds = Math.min(MAX_CLIPBOARD_CLEAR_SECONDS,
            Math.max(MIN_CLIPBOARD_CLEAR_SECONDS, Math.round(seconds)));
        this.saveSettings();
    }

    getAllowPasskeysLocalhost(): boolean {
        return this.current.allowPasskeysLocalhost ?? false;
    }

    setAllowPasskeysLocalhost(enabled: boolean): void {
        this.current.allowPasskeysLocalhost = enabled;
        this.saveSettings();
    }

    getAlwaysAllowBrowserAccess(): boolean {
        return this.current.alwaysAllowBrowserAccess ?? false;
    }

    setAlwaysAllowBrowserAccess(enabled: boolean): void {
        this.current.alwaysAllowBrowserAccess = enabled;
        this.saveSettings();
    }

    getTheme(): Theme {
        return this.current.theme;
    }

    setTheme(theme: Theme): void {
        this.current.theme = theme;
        this.saveSettings();
    }

    getHibpApiKey(): string | undefined {
        return this.current.hibpApiKey;
    }

    setHibpApiKey(apiKey: string | undefined): void {
        this.current.hibpApiKey = apiKey;
        this.saveSettings();
    }

    getAutoLockEnabled(): boolean {
        return this.current.autoLockEnabled;
    }

    setAutoLockEnabled(enabled: boolean): void {
        this.current.autoLockEnabled = enabled;
        this.saveSettings();
    }

    getAutoLockDuration(): number {
        return this.current.autoLockDuration;
    }

    setAutoLockDuration(duration: number): void {
        this.current.autoLockDuration = duration;
        this.saveSettings();
    }

    getKeyFilePath(databasePath: string): string | undefined {
        return this.current.keyFilePaths?.[databasePath];
    }

    setKeyFilePath(databasePath: string, keyFilePath: string | undefined): void {
        const paths = { ...(this.current.keyFilePaths ?? {}) };
        if (keyFilePath) {
            paths[databasePath] = keyFilePath;
        } else {
            delete paths[databasePath];
        }
        this.current.keyFilePaths = paths;
        this.saveSettings();
    }

    getHardwareKey(databasePath: string): HardwareKeyPreference | undefined {
        return this.current.hardwareKeys?.[databasePath];
    }

    setHardwareKey(databasePath: string, key: HardwareKeyPreference | undefined): void {
        const keys = { ...(this.current.hardwareKeys ?? {}) };
        if (key) {
            keys[databasePath] = key;
        } else {
            delete keys[databasePath];
        }
        this.current.hardwareKeys = keys;
        this.saveSettings();
    }

    // Identifies this installation to the history notes a vault carries. Held
    // in a field of its own as well as in storage, so a run with no storage at
    // all (the test environment, a profile that cannot write) still gets one
    // identity for its whole session instead of a new one per call
    getReplicaId(): string {
        if (!this.replicaId) {
            this.replicaId = this.current.replicaId ?? this.newReplicaId();
        }
        if (this.current.replicaId !== this.replicaId) {
            this.current.replicaId = this.replicaId;
            this.saveSettings();
        }
        return this.replicaId;
    }

    private replicaId: string | undefined;

    private newReplicaId(): string {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Method to get all settings (useful for debugging or backup)
    getAllSettings(): UserSettings {
        return { ...this.current };
    }
}

// Export a singleton instance
export const userSettingsService = new UserSettingsService();
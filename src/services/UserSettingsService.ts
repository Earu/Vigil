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
}

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

        // Default settings
        return {
            theme: 'dark',
            hibpApiKey: undefined,
            autoLockEnabled: false,
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

    getAllowPasskeysLocalhost(): boolean {
        return this.current.allowPasskeysLocalhost ?? false;
    }

    setAllowPasskeysLocalhost(enabled: boolean): void {
        this.current.allowPasskeysLocalhost = enabled;
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

    // Method to get all settings (useful for debugging or backup)
    getAllSettings(): UserSettings {
        return { ...this.current };
    }
}

// Export a singleton instance
export const userSettingsService = new UserSettingsService();
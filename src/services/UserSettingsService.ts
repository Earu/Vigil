export type Theme = 'dark' | 'light' | 'system';

interface UserSettings {
    theme: Theme;
    hibpApiKey?: string;
    autoLockEnabled: boolean;
    autoLockDuration: number;
    // Remembered key file path per database path. Only paths are stored,
    // never key material
    keyFilePaths?: Record<string, string>;
}

const SETTINGS_KEY = 'vigil_user_settings';

class UserSettingsService {
    private settings: UserSettings;

    constructor() {
        this.settings = this.loadSettings();
    }

    private loadSettings(): UserSettings {
        const savedSettings = localStorage.getItem(SETTINGS_KEY);
        if (savedSettings) {
            return JSON.parse(savedSettings);
        }

        // Default settings
        return {
            theme: 'dark',
            hibpApiKey: undefined,
            autoLockEnabled: false,
            autoLockDuration: 20
        };
    }

    private saveSettings(): void {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    }

    getTheme(): Theme {
        return this.settings.theme;
    }

    setTheme(theme: Theme): void {
        this.settings.theme = theme;
        this.saveSettings();
    }

    getHibpApiKey(): string | undefined {
        return this.settings.hibpApiKey;
    }

    setHibpApiKey(apiKey: string | undefined): void {
        this.settings.hibpApiKey = apiKey;
        this.saveSettings();
    }

    getAutoLockEnabled(): boolean {
        return this.settings.autoLockEnabled;
    }

    setAutoLockEnabled(enabled: boolean): void {
        this.settings.autoLockEnabled = enabled;
        this.saveSettings();
    }

    getAutoLockDuration(): number {
        return this.settings.autoLockDuration;
    }

    setAutoLockDuration(duration: number): void {
        this.settings.autoLockDuration = duration;
        this.saveSettings();
    }

    getKeyFilePath(databasePath: string): string | undefined {
        return this.settings.keyFilePaths?.[databasePath];
    }

    setKeyFilePath(databasePath: string, keyFilePath: string | undefined): void {
        const paths = { ...(this.settings.keyFilePaths ?? {}) };
        if (keyFilePath) {
            paths[databasePath] = keyFilePath;
        } else {
            delete paths[databasePath];
        }
        this.settings.keyFilePaths = paths;
        this.saveSettings();
    }

    // Method to get all settings (useful for debugging or backup)
    getAllSettings(): UserSettings {
        return { ...this.settings };
    }
}

// Export a singleton instance
export const userSettingsService = new UserSettingsService();
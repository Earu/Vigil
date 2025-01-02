export type Theme = 'dark' | 'light' | 'system';

interface UserSettings {
    theme: Theme;
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
            theme: 'dark'
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

    // Method to get all settings (useful for debugging or backup)
    getAllSettings(): UserSettings {
        return { ...this.settings };
    }
}

// Export a singleton instance
export const userSettingsService = new UserSettingsService();
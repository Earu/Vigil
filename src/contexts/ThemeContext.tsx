import React, { createContext, useContext, useEffect, useState } from 'react';
import { Theme, userSettingsService } from '../services/UserSettingsService';

interface ThemeContextType {
    theme: Theme;
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setTheme] = useState<Theme>(() => userSettingsService.getTheme());

    useEffect(() => {
        const handleThemeChange = () => {
            if (theme === 'system') {
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                document.documentElement.classList.toggle('light-theme', !prefersDark);
            } else {
                document.documentElement.classList.toggle('light-theme', theme === 'light');
            }
        };

        userSettingsService.setTheme(theme);
        handleThemeChange();

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addListener(handleThemeChange);

        return () => mediaQuery.removeListener(handleThemeChange);
    }, [theme]);

    return (
        <ThemeContext.Provider value={{ theme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}
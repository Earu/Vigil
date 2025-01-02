import { useTheme } from '../../contexts/ThemeContext';
import { CloseIcon } from '../../icons';
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from '../../icons/SettingsIcon';
import './Settings.css';

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
}

export function Settings({ isOpen, onClose }: SettingsProps) {
    const { theme, setTheme } = useTheme();

    if (!isOpen) return null;

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-dialog" onClick={e => e.stopPropagation()}>
                <div className="settings-header">
                    <h2>Settings</h2>
                    <button className="close-button" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>
                <div className="settings-content">
                    <div className="settings-section">
                        <h3>Appearance</h3>
                        <div className="theme-selector">
                            <div className="theme-options">
                                <button
                                    className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                                    onClick={() => setTheme('dark')}
                                >
                                    <DarkThemeIcon />
                                    Dark Theme
                                </button>
                                <button
                                    className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                                    onClick={() => setTheme('light')}
                                >
                                    <LightThemeIcon />
                                    Light Theme
                                </button>
                                <button
                                    className={`theme-option ${theme === 'system' ? 'active' : ''}`}
                                    onClick={() => setTheme('system')}
                                >
                                    <SystemThemeIcon />
                                    System Theme
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
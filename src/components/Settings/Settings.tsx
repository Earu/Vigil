import { useTheme } from '../../contexts/ThemeContext';
import { CloseIcon } from '../../icons';
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from '../../icons/SettingsIcon';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import { userSettingsService } from '../../services/UserSettingsService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { useState } from 'react';
import './Settings.css';

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
}

export function Settings({ isOpen, onClose }: SettingsProps) {
    const { theme, setTheme } = useTheme();
    const [apiKey, setApiKey] = useState<string>(userSettingsService.getHibpApiKey() || '');
    const [showApiKey, setShowApiKey] = useState(false);

    if (!isOpen) return null;

    const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newApiKey = e.target.value;
        setApiKey(newApiKey);
        userSettingsService.setHibpApiKey(newApiKey || undefined);
    };

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
                    <div className="settings-section">
                        <h3>Security</h3>
                        <div className="api-key-input">
                            <label htmlFor="hibp-api-key">Have I Been Pwned API Key</label>
                            <div className="input-with-toggle">
                                <input
                                    type={showApiKey ? 'text' : 'password'}
                                    id="hibp-api-key"
                                    value={apiKey}
                                    onChange={handleApiKeyChange}
                                    placeholder="Enter your HIBP API key"
                                />
                                <button
                                    className="toggle-visibility"
                                    onClick={() => setShowApiKey(!showApiKey)}
                                    type="button"
                                >
                                    {showApiKey ? <HidePasswordIcon /> : <ShowPasswordIcon />}
                                </button>
                            </div>
                            <p className="api-key-help">
                                Get your API key from{' '}
                                <a href="https://haveibeenpwned.com/API/Key" target="_blank" rel="noopener noreferrer" onClick={() => window.electron?.openExternal('https://haveibeenpwned.com/API/Key')}>
                                    haveibeenpwned.com
                                </a>
                            </p>
                            <div className="cache-controls">
                                <button
                                    className="clear-cache-button"
                                    onClick={() => {
                                        BreachStatusStore.clearAll();
                                        EmailBreachStatusStore.clearAll();
                                        (window as any).showToast?.({
                                            message: 'Breach check cache cleared',
                                            type: 'success',
                                            duration: 3000
                                        });
                                    }}
                                >
                                    Clear Cache
                                </button>
                                <p className="cache-help">Clears stored breach check results</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
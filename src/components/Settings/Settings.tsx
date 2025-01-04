import { useTheme } from '../../contexts/ThemeContext';
import { CloseIcon } from '../../icons';
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from '../../icons/SettingsIcon';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import { ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { userSettingsService } from '../../services/UserSettingsService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { CsvImportService } from '../../services/CsvImportService';
import { useState } from 'react';
import * as kdbxweb from 'kdbxweb';
import './Settings.css';

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
    kdbxDb: kdbxweb.Kdbx | null;
}

export function Settings({ isOpen, onClose, kdbxDb }: SettingsProps) {
    const { theme, setTheme } = useTheme();
    const [apiKey, setApiKey] = useState<string>(userSettingsService.getHibpApiKey() || '');
    const [showApiKey, setShowApiKey] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);

    if (!isOpen) return null;

    const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newApiKey = e.target.value;
        setApiKey(newApiKey);
        userSettingsService.setHibpApiKey(newApiKey || undefined);
    };

    const handleCsvImport = async () => {
        if (!kdbxDb) {
            (window as any).showToast?.({
                message: 'No database is currently open',
                type: 'error',
                duration: 3000
            });
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const passwords = await CsvImportService.importFromCsv(file);
                
                // Show confirmation dialog
                const confirmImport = window.confirm(`You are about to import ${passwords.length} passwords. Are you sure?`);
                if (!confirmImport) return;

                await CsvImportService.importToDatabase(passwords, kdbxDb);
                setShowImportModal(false);

                (window as any).showToast?.({
                    message: `Successfully imported ${passwords.length} passwords`,
                    type: 'success',
                    duration: 3000
                });
            } catch (err) {
                console.error('Failed to import CSV:', err);
                (window as any).showToast?.({
                    message: err instanceof Error ? err.message : 'Failed to import CSV file',
                    type: 'error',
                    duration: 5000
                });
            }
        };

        input.click();
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

                    {kdbxDb && (
                        <div className="settings-section">
                            <h3>Database Management</h3>
                            <div className="database-controls">
                                <button
                                    className="import-csv-button"
                                    onClick={() => setShowImportModal(true)}
                                >
                                    <ImportAuthIcon className="import-icon" />
                                    Import from CSV
                                </button>
                                <p className="database-help">Import passwords from a CSV file into your current database</p>
                            </div>
                        </div>
                    )}

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

            {showImportModal && (
                <div className="settings-modal-overlay">
                    <div className="settings-import-modal">
                        <div className="settings-modal-header">
                            <h3>Import Passwords from CSV</h3>
                            <button
                                className="close-button"
                                onClick={() => setShowImportModal(false)}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                        <div className="settings-modal-content">
                            <p>Select a CSV file containing your exported passwords.</p>
                            <p className="help-text">
                                The CSV file should contain columns for URL, username, and password.
                                You can export these from your browser's password manager.
                            </p>
                        </div>
                        <div className="settings-modal-footer">
                            <button
                                className="settings-secondary-button"
                                onClick={() => setShowImportModal(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="settings-primary-button"
                                onClick={handleCsvImport}
                            >
                                Select CSV File
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
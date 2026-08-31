import { useTheme } from '../../contexts/ThemeContext';
import { CloseActionIcon } from '../../icons/actions/ActionIcons';
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from '../../icons/SettingsIcon';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import { ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { userSettingsService } from '../../services/UserSettingsService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { CsvImportService } from '../../services/CsvImportService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { useState, useEffect } from 'react';
import * as kdbxweb from 'kdbxweb';
import { UpdateStatus } from '../../types/electron';
import './Settings.css';

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
    kdbxDb: kdbxweb.Kdbx | null;
    autoLockEnabled: boolean;
    setAutoLockEnabled: (enabled: boolean) => void;
    autoLockDuration: number;
    setAutoLockDuration: (duration: number) => void;
    onDatabaseChange?: () => void;
}

export function Settings({ isOpen, onClose, kdbxDb, autoLockEnabled, setAutoLockEnabled, autoLockDuration, setAutoLockDuration, onDatabaseChange }: SettingsProps) {
    const { theme, setTheme } = useTheme();
    const [apiKey, setApiKey] = useState<string>(userSettingsService.getHibpApiKey() || '');
    const [showApiKey, setShowApiKey] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);
    const [fetchFavicons, setFetchFavicons] = useState<boolean>(userSettingsService.getFetchFavicons());
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

    useEffect(() => {
        if (!window.electron) return;
        window.electron.getUpdateStatus().then(setUpdateStatus).catch(() => {});
        const handler = (status: UpdateStatus) => setUpdateStatus(status);
        window.electron.on('update-status', handler);
        return () => window.electron?.off('update-status', handler);
    }, []);

    if (!isOpen) return null;

    const updateStatusText = (() => {
        switch (updateStatus?.state) {
            case 'checking': return 'Checking for updates...';
            case 'up-to-date': return 'Vigil is up to date.';
            case 'downloading': return `Downloading v${updateStatus.version}...`;
            case 'downloaded': return `v${updateStatus.version} is ready to install.`;
            case 'error': return `Update check failed: ${updateStatus.message}`;
            case 'disabled': return 'Automatic updates are not available in this build.';
            default: return 'Updates are checked when the app starts.';
        }
    })();

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
                onDatabaseChange?.();

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

    const hasKeyFile = !!kdbxDb?.credentials.keyFileHash;

    const applyKeyFile = async (keyFileData: ArrayBuffer | null, keyFilePath: string | undefined, successMessage: string) => {
        if (!kdbxDb) return;

        try {
            await kdbxDb.credentials.setKeyFile(keyFileData);
            // Re-encrypts the database with the new composite key
            onDatabaseChange?.();

            const dbPath = KeepassDatabaseService.getPath();
            if (dbPath) {
                userSettingsService.setKeyFilePath(dbPath, keyFilePath);
            }

            (window as any).showToast?.({
                message: successMessage,
                type: 'success',
                duration: 3000
            });
        } catch (err) {
            console.error('Failed to update key file:', err);
            (window as any).showToast?.({
                message: 'Failed to update key file',
                type: 'error',
                duration: 5000
            });
        }
    };

    const handleUseExistingKeyFile = async () => {
        const selected = await window.electron?.selectKeyFile();
        if (!selected?.filePath) return;

        const confirmed = window.confirm(
            'The database will be re-encrypted and this key file will be required to unlock it, together with your password. Keep the key file safe: losing it means losing access to the database. Continue?'
        );
        if (!confirmed) return;

        const result = await window.electron?.readFile(selected.filePath);
        if (!result?.success || !result.data) {
            (window as any).showToast?.({
                message: 'Failed to read key file',
                type: 'error',
                duration: 5000
            });
            return;
        }

        await applyKeyFile(new Uint8Array(result.data).buffer, selected.filePath, hasKeyFile ? 'Key file changed' : 'Key file added');
    };

    const handleGenerateKeyFile = async () => {
        const confirmed = window.confirm(
            'A new random key file will be generated and the database re-encrypted with it. You will need it to unlock the database, together with your password. Keep it safe: losing it means losing access to the database. Continue?'
        );
        if (!confirmed) return;

        const keyFileBytes = await kdbxweb.Credentials.createRandomKeyFile(2);
        const defaultName = `${kdbxDb?.meta.name || 'database'}.keyx`;
        const saved = await window.electron?.saveAttachment(defaultName, keyFileBytes);
        if (!saved?.success || !saved.filePath) return;

        await applyKeyFile(new Uint8Array(keyFileBytes).buffer, saved.filePath, `Key file generated at ${saved.filePath}`);
    };

    const handleRemoveKeyFile = async () => {
        const confirmed = window.confirm(
            'The database will be re-encrypted and protected by your password only. Continue?'
        );
        if (!confirmed) return;

        await applyKeyFile(null, undefined, 'Key file removed');
    };

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-dialog" onClick={e => e.stopPropagation()}>
                <div className="settings-header">
                    <h2>Settings</h2>
                    <button className="close-button" onClick={onClose}>
                        <CloseActionIcon />
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
                            <div className="key-file-controls">
                                <label>Key file protection</label>
                                <p className="database-help">
                                    {hasKeyFile
                                        ? 'This database requires a key file to unlock.'
                                        : 'This database is protected by password only.'}
                                </p>
                                <div className="key-file-buttons">
                                    <button className="settings-secondary-button" onClick={handleUseExistingKeyFile}>
                                        {hasKeyFile ? 'Change key file' : 'Use existing file'}
                                    </button>
                                    <button className="settings-secondary-button" onClick={handleGenerateKeyFile}>
                                        Generate key file
                                    </button>
                                    {hasKeyFile && (
                                        <button className="settings-secondary-button key-file-remove" onClick={handleRemoveKeyFile}>
                                            Remove key file
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="settings-section">
                        <h3>Security</h3>
                        <div className="auto-lock-controls">
                            <div className="auto-lock-toggle">
                                <label htmlFor="auto-lock-enabled">Enable automatic locking</label>
                                <input
                                    type="checkbox"
                                    id="auto-lock-enabled"
                                    checked={autoLockEnabled}
                                    onChange={(e) => {
                                        setAutoLockEnabled(e.target.checked);
                                        userSettingsService.setAutoLockEnabled(e.target.checked);
                                    }}
                                />
                            </div>
                            <div className={`auto-lock-duration ${autoLockEnabled ? 'enabled' : ''}`}>
                                <label htmlFor="auto-lock-duration">Duration (minutes)</label>
                                <input
                                    type="number"
                                    id="auto-lock-duration"
                                    value={autoLockDuration}
                                    min="1"
                                    max="480"
                                    disabled={!autoLockEnabled}
                                    onChange={(e) => {
                                        const value = Math.max(1, Math.min(480, parseInt(e.target.value) || 20));
                                        setAutoLockDuration(value);
                                        userSettingsService.setAutoLockDuration(value);
                                    }}
                                />
                            </div>
                            <p className="auto-lock-help">When enabled, the database will automatically lock after the specified period of time</p>
                        </div>
                        <div className="favicon-controls">
                            <div className="auto-lock-toggle">
                                <label htmlFor="fetch-favicons">Fetch website icons from Google</label>
                                <input
                                    type="checkbox"
                                    id="fetch-favicons"
                                    checked={fetchFavicons}
                                    onChange={(e) => {
                                        setFetchFavicons(e.target.checked);
                                        userSettingsService.setFetchFavicons(e.target.checked);
                                    }}
                                />
                            </div>
                            <p className="auto-lock-help">Shows each entry's website icon, but sends the entry's domain to Google's favicon service</p>
                        </div>
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

                    {window.electron && (
                        <div className="settings-section">
                            <h3>Updates</h3>
                            <div className="update-controls">
                                <div className="update-status-row">
                                    <span className="update-status-text">{updateStatusText}</span>
                                    {updateStatus?.state === 'downloaded' ? (
                                        <button
                                            className="settings-primary-button"
                                            onClick={() => window.electron?.installUpdate()}
                                        >
                                            Restart and install
                                        </button>
                                    ) : (
                                        <button
                                            className="clear-cache-button"
                                            disabled={updateStatus?.state === 'checking' || updateStatus?.state === 'downloading' || updateStatus?.state === 'disabled'}
                                            onClick={() => window.electron?.checkForUpdates()}
                                        >
                                            Check for updates
                                        </button>
                                    )}
                                </div>
                                <p className="auto-lock-help">Version {__APP_VERSION__}. Downloaded updates install automatically when the app closes.</p>
                            </div>
                        </div>
                    )}
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
                                <CloseActionIcon />
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
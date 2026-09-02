import { useTheme } from '../../contexts/ThemeContext';
import { CloseActionIcon, DownloadActionIcon } from '../../icons/actions/ActionIcons';
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from '../../icons/SettingsIcon';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import { ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { userSettingsService, MIN_BACKUP_KEEP, MAX_BACKUP_KEEP } from '../../services/UserSettingsService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { ImportService } from '../../services/ImportService';
import { ExportService } from '../../services/ExportService';
import { BrowserIntegrationService } from '../../services/BrowserIntegrationService';
import { KeepassDatabaseService, KdfInfo } from '../../services/KeepassDatabaseService';
import { useState, useEffect } from 'react';
import * as kdbxweb from 'kdbxweb';
import { UpdateStatus, BackupInfo } from '../../types/electron';
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
    const [backupOptions, setBackupOptions] = useState(() => userSettingsService.getBackupOptions());
    const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null);

    // Summary of what is on disk, refreshed each time the panel opens
    useEffect(() => {
        const vaultPath = KeepassDatabaseService.getPath();
        if (!isOpen || !vaultPath || !window.electron) {
            setBackupInfo(null);
            return;
        }
        window.electron.getBackupInfo(vaultPath).then(setBackupInfo).catch(() => setBackupInfo(null));
    }, [isOpen]);
    const { theme, setTheme } = useTheme();
    const [apiKey, setApiKey] = useState<string>(userSettingsService.getHibpApiKey() || '');
    const [showApiKey, setShowApiKey] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);
    const [fetchFavicons, setFetchFavicons] = useState<boolean>(userSettingsService.getFetchFavicons());
    const [allowPasskeysLocalhost, setAllowPasskeysLocalhost] = useState<boolean>(userSettingsService.getAllowPasskeysLocalhost());
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
    const [dbName, setDbName] = useState('');
    const [dbDesc, setDbDesc] = useState('');
    const [currentPw, setCurrentPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [confirmPw, setConfirmPw] = useState('');
    const [pwError, setPwError] = useState('');
    const [kdfInfo, setKdfInfo] = useState<KdfInfo | null>(null);
    const [historyMax, setHistoryMax] = useState(10);
    const [activeTab, setActiveTab] = useState<'general' | 'database' | 'security'>('general');
    const [browserIntegration, setBrowserIntegration] = useState<{ supported: boolean; enabled: boolean; running: boolean } | null>(null);
    const [browserAssociations, setBrowserAssociations] = useState<Array<{ name: string; key: string }>>([]);
    const [contentProtection, setContentProtection] = useState<{ supported: boolean; enabled: boolean } | null>(null);

    // Fresh dialog starts on the first tab; the Database tab disappears with
    // the database
    useEffect(() => {
        if (isOpen) setActiveTab('general');
    }, [isOpen]);
    const currentTab = activeTab === 'database' && !kdbxDb ? 'general' : activeTab;

    // Seed the database settings form from the open database
    useEffect(() => {
        if (!isOpen || !kdbxDb) return;
        setDbName(kdbxDb.meta.name ?? '');
        setDbDesc(kdbxDb.meta.desc ?? '');
        setKdfInfo(KeepassDatabaseService.getKdfInfo(kdbxDb));
        setHistoryMax(KeepassDatabaseService.getHistoryMaxItems(kdbxDb));
        setCurrentPw('');
        setNewPw('');
        setConfirmPw('');
        setPwError('');
    }, [isOpen, kdbxDb]);

    useEffect(() => {
        if (!window.electron) return;
        window.electron.getUpdateStatus().then(setUpdateStatus).catch(() => {});
        const handler = (status: UpdateStatus) => setUpdateStatus(status);
        const unsubscribe = window.electron.on('update-status', handler);
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (!isOpen || !window.electron) return;
        window.electron.getBrowserIntegrationStatus()
            .then(status => setBrowserIntegration({ supported: status.supported, enabled: status.enabled, running: status.running }))
            .catch(() => {});
        window.electron.getContentProtection().then(setContentProtection).catch(() => {});
        const refreshAssociations = () =>
            setBrowserAssociations(kdbxDb ? BrowserIntegrationService.listAssociations(kdbxDb) : []);
        refreshAssociations();
        // A pairing completed while this dialog is open shows up immediately
        window.addEventListener('vigil-browser-associations-changed', refreshAssociations);
        return () => window.removeEventListener('vigil-browser-associations-changed', refreshAssociations);
    }, [isOpen, kdbxDb]);

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

    const handleContentProtectionToggle = async (enabled: boolean) => {
        if (!window.electron || !contentProtection?.supported) return;
        const result = await window.electron.setContentProtection(enabled);
        setContentProtection({ supported: true, enabled: result.enabled });
        if (!result.success) {
            (window as any).showToast?.({
                message: result.error || 'Failed to change screen capture protection',
                type: 'error',
                duration: 5000
            });
        }
    };

    const handleBrowserIntegrationToggle = async (enabled: boolean) => {
        if (!window.electron || !browserIntegration?.supported) return;
        const result = await window.electron.setBrowserIntegrationEnabled(enabled);
        setBrowserIntegration({ supported: true, enabled, running: result.running });
        if (!result.success) {
            (window as any).showToast?.({
                message: result.error || 'Failed to start the browser integration server',
                type: 'error',
                duration: 5000
            });
            return;
        }
        if (enabled) {
            const count = result.written?.length ?? 0;
            (window as any).showToast?.({
                message: count > 0
                    ? `Browser integration enabled and registered with ${count} browser${count > 1 ? 's' : ''}`
                    : 'Browser integration enabled, but no supported browsers were found',
                type: count > 0 ? 'success' : 'warning',
                duration: 4000
            });
        }
    };

    const handleRemoveAssociation = (name: string) => {
        if (!kdbxDb) return;
        BrowserIntegrationService.removeAssociation(kdbxDb, name);
        onDatabaseChange?.();
        setBrowserAssociations(BrowserIntegrationService.listAssociations(kdbxDb));
    };

    const handleCsvExport = async () => {
        if (!kdbxDb || !window.electron) return;

        // Collected once and reused for the count, the formula check and the
        // file itself, rather than walking the vault three times
        const rows = ExportService.collectRows(kdbxDb);
        const count = rows.length;

        // Only raised when the vault actually holds one; see formulaRisks
        const risks = ExportService.formulaRisks(rows);
        const examples = risks.slice(0, 3)
            .map(risk => `"${risk.title}" (${risk.column})`)
            .join(', ');
        const formulaWarning = risks.length === 0 ? '' : `\n\n`
            + `Warning: ${risks.length} ${risks.length === 1 ? 'field' : 'fields'} in this vault `
            + `${risks.length === 1 ? 'starts' : 'start'} with a spreadsheet formula: ${examples}`
            + `${risks.length > 3 ? ', and others' : ''}. Excel and Google Sheets run formulas when the `
            + `file is opened, and a formula can read the password column beside it. Open this export `
            + `in a text editor rather than a spreadsheet.`;

        const confirmed = window.confirm(
            `Export ${count} entries to a plaintext CSV file? Anyone who can read that file can read every password in it.`
            + formulaWarning
        );
        if (!confirmed) return;

        const csv = ExportService.toCsv(kdbxDb, rows);
        const result = await window.electron.saveAttachment(
            ExportService.exportFileName(kdbxDb),
            new TextEncoder().encode(csv)
        );
        if (result.success) {
            (window as any).showToast?.({
                message: `Exported ${count} entries to ${result.filePath}`,
                type: 'success',
                duration: 4000
            });
        } else if (result.error !== 'Save cancelled') {
            (window as any).showToast?.({
                message: result.error || 'Failed to export',
                type: 'error',
                duration: 5000
            });
        }
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
        input.accept = '.csv,.json';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const result = await ImportService.parseFile(file);

                const skippedNote = result.skipped > 0 ? ` (${result.skipped} unsupported items skipped)` : '';
                const confirmImport = window.confirm(
                    `Import ${result.entries.length} entries from ${result.source}${skippedNote}?`
                );
                if (!confirmImport) return;

                // onDatabaseChange performs the save; writing entries here and
                // saving there avoids a redundant second save
                ImportService.writeEntries(result, kdbxDb);
                setShowImportModal(false);
                onDatabaseChange?.();

                (window as any).showToast?.({
                    message: `Imported ${result.entries.length} entries from ${result.source}`,
                    type: 'success',
                    duration: 3000
                });
            } catch (err) {
                console.error('Failed to import:', err);
                (window as any).showToast?.({
                    message: err instanceof Error ? err.message : 'Failed to import file',
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

    const showSettingsToast = (message: string, type: 'success' | 'error' = 'success') => {
        (window as any).showToast?.({ message, type, duration: 3000 });
    };

    const handleApplyDetails = () => {
        if (!kdbxDb || !dbName.trim()) return;
        kdbxDb.meta.name = dbName.trim();
        kdbxDb.meta.desc = dbDesc;
        onDatabaseChange?.();
        showSettingsToast('Database details saved');
    };

    const handleChangePassword = async () => {
        if (!kdbxDb) return;
        setPwError('');

        if (!newPw) {
            setPwError('The new password cannot be empty');
            return;
        }
        if (newPw !== confirmPw) {
            setPwError('The new passwords do not match');
            return;
        }
        if (!(await KeepassDatabaseService.verifyMasterPassword(kdbxDb, currentPw))) {
            setPwError('The current password is incorrect');
            return;
        }

        await KeepassDatabaseService.changeMasterPassword(kdbxDb, newPw);
        onDatabaseChange?.();

        // Keep biometric unlock working: it stores the master password
        const dbPath = KeepassDatabaseService.getPath();
        if (dbPath && window.electron) {
            try {
                const bio = await window.electron.hasBiometricsEnabled(dbPath);
                if (bio.success && bio.enabled) {
                    await window.electron.enableBiometrics(dbPath, newPw);
                }
            } catch (err) {
                console.error('Failed to refresh biometric credentials:', err);
            }
        }

        setCurrentPw('');
        setNewPw('');
        setConfirmPw('');
        showSettingsToast('Master password changed');
    };

    const handleApplyKdf = () => {
        if (!kdbxDb || !kdfInfo) return;
        KeepassDatabaseService.setKdf(kdbxDb, kdfInfo);
        onDatabaseChange?.();
        setKdfInfo(KeepassDatabaseService.getKdfInfo(kdbxDb));
        showSettingsToast('Key derivation settings applied');
    };

    const handleApplyHistory = () => {
        if (!kdbxDb) return;
        KeepassDatabaseService.setHistoryMaxItems(kdbxDb, historyMax);
        onDatabaseChange?.();
        showSettingsToast('History retention updated');
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
                <div className="settings-tabs">
                    <button
                        className={`settings-tab ${currentTab === 'general' ? 'active' : ''}`}
                        onClick={() => setActiveTab('general')}
                    >
                        General
                    </button>
                    {kdbxDb && (
                        <button
                            className={`settings-tab ${currentTab === 'database' ? 'active' : ''}`}
                            onClick={() => setActiveTab('database')}
                        >
                            Database
                        </button>
                    )}
                    <button
                        className={`settings-tab ${currentTab === 'security' ? 'active' : ''}`}
                        onClick={() => setActiveTab('security')}
                    >
                        Security
                    </button>
                </div>
                <div className="settings-content">
                    {currentTab === 'general' && (
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
                    )}

                    {currentTab === 'database' && kdbxDb && (
                        <div className="settings-section">
                            <div className="db-details-controls">
                                <label>Database details</label>
                                <div className="db-field-row">
                                    <span>Name</span>
                                    <input
                                        type="text"
                                        className="db-input"
                                        value={dbName}
                                        onChange={(e) => setDbName(e.target.value)}
                                    />
                                </div>
                                <div className="db-field-row">
                                    <span>Description</span>
                                    <input
                                        type="text"
                                        className="db-input"
                                        value={dbDesc}
                                        placeholder="Optional"
                                        onChange={(e) => setDbDesc(e.target.value)}
                                    />
                                </div>
                                <div className="db-apply-row">
                                    <button className="settings-secondary-button" onClick={handleApplyDetails} disabled={!dbName.trim()}>
                                        Save details
                                    </button>
                                </div>
                            </div>
                            <div className="master-password-controls">
                                <label>Master password</label>
                                <div className="db-field-row">
                                    <span>Current password</span>
                                    <input
                                        type="password"
                                        className="db-input"
                                        value={currentPw}
                                        onChange={(e) => { setCurrentPw(e.target.value); setPwError(''); }}
                                    />
                                </div>
                                <div className="db-field-row">
                                    <span>New password</span>
                                    <input
                                        type="password"
                                        className="db-input"
                                        value={newPw}
                                        onChange={(e) => { setNewPw(e.target.value); setPwError(''); }}
                                    />
                                </div>
                                <div className="db-field-row">
                                    <span>Confirm new password</span>
                                    <input
                                        type="password"
                                        className="db-input"
                                        value={confirmPw}
                                        onChange={(e) => { setConfirmPw(e.target.value); setPwError(''); }}
                                    />
                                </div>
                                {pwError && <p className="db-settings-error">{pwError}</p>}
                                <div className="db-apply-row">
                                    <button
                                        className="settings-secondary-button"
                                        onClick={handleChangePassword}
                                        disabled={!currentPw || !newPw || !confirmPw}
                                    >
                                        Change password
                                    </button>
                                </div>
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
                            {kdfInfo && (
                                <div className="kdf-controls">
                                    <label>Key derivation</label>
                                    {(kdfInfo.type === 'argon2d' || kdfInfo.type === 'argon2id') ? (
                                        <>
                                            <div className="db-field-row">
                                                <span>Algorithm</span>
                                                <select
                                                    className="db-input"
                                                    value={kdfInfo.type}
                                                    onChange={(e) => setKdfInfo({ ...kdfInfo, type: e.target.value as KdfInfo['type'] })}
                                                >
                                                    <option value="argon2d">Argon2d</option>
                                                    <option value="argon2id">Argon2id</option>
                                                </select>
                                            </div>
                                            <div className="db-field-row">
                                                <span>Memory (MiB)</span>
                                                <input
                                                    type="number"
                                                    className="db-input"
                                                    min="8" max="4096"
                                                    value={kdfInfo.memoryMiB ?? 64}
                                                    onChange={(e) => setKdfInfo({ ...kdfInfo, memoryMiB: Math.max(8, Math.min(4096, parseInt(e.target.value) || 64)) })}
                                                />
                                            </div>
                                            <div className="db-field-row">
                                                <span>Iterations</span>
                                                <input
                                                    type="number"
                                                    className="db-input"
                                                    min="1" max="1000"
                                                    value={kdfInfo.iterations}
                                                    onChange={(e) => setKdfInfo({ ...kdfInfo, iterations: Math.max(1, Math.min(1000, parseInt(e.target.value) || 1)) })}
                                                />
                                            </div>
                                            <div className="db-field-row">
                                                <span>Parallelism</span>
                                                <input
                                                    type="number"
                                                    className="db-input"
                                                    min="1" max="16"
                                                    value={kdfInfo.parallelism ?? 1}
                                                    onChange={(e) => setKdfInfo({ ...kdfInfo, parallelism: Math.max(1, Math.min(16, parseInt(e.target.value) || 1)) })}
                                                />
                                            </div>
                                        </>
                                    ) : (
                                        <div className="db-field-row">
                                            <span>Encryption rounds</span>
                                            <input
                                                type="number"
                                                className="db-input"
                                                min="1"
                                                value={kdfInfo.iterations}
                                                onChange={(e) => setKdfInfo({ ...kdfInfo, iterations: Math.max(1, parseInt(e.target.value) || 1) })}
                                            />
                                        </div>
                                    )}
                                    <p className="database-help">Higher values are harder to brute-force and slower to unlock</p>
                                    <div className="db-apply-row">
                                        <button className="settings-secondary-button" onClick={handleApplyKdf}>
                                            Apply key derivation
                                        </button>
                                    </div>
                                </div>
                            )}
                            <div className="history-retention-controls">
                                <label>Entry history</label>
                                <div className="db-field-row">
                                    <span>Versions kept per entry</span>
                                    <input
                                        type="number"
                                        className="db-input"
                                        min="0" max="100"
                                        value={historyMax}
                                        onChange={(e) => setHistoryMax(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))}
                                    />
                                </div>
                                <p className="database-help">Older versions beyond this count are dropped on save</p>
                                <div className="db-apply-row">
                                    <button className="settings-secondary-button" onClick={handleApplyHistory}>
                                        Apply retention
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {currentTab === 'security' && (
                    <div className="settings-section">
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
                        <div className="backup-controls">
                            <div className="auto-lock-toggle">
                                <label htmlFor="backups-enabled">Keep backups before saving</label>
                                <input
                                    type="checkbox"
                                    id="backups-enabled"
                                    checked={backupOptions.enabled}
                                    onChange={(e) => {
                                        userSettingsService.setBackupsEnabled(e.target.checked);
                                        setBackupOptions(userSettingsService.getBackupOptions());
                                    }}
                                />
                            </div>
                            <div className={`auto-lock-duration ${backupOptions.enabled ? 'enabled' : ''}`}>
                                <label htmlFor="backup-keep">Copies to keep</label>
                                <input
                                    type="number"
                                    id="backup-keep"
                                    value={backupOptions.keep}
                                    min={MIN_BACKUP_KEEP}
                                    max={MAX_BACKUP_KEEP}
                                    disabled={!backupOptions.enabled}
                                    onChange={(e) => {
                                        userSettingsService.setBackupKeep(parseInt(e.target.value) || 5);
                                        setBackupOptions(userSettingsService.getBackupOptions());
                                    }}
                                />
                            </div>
                            <p className="auto-lock-help">Keeps recent copies of your database so you can go back if a save goes wrong, at most one every 30 minutes</p>
                            {backupInfo && (
                                <div className="backup-status">
                                    <span>
                                        {backupInfo.count === 0
                                            ? 'No backups yet'
                                            : `${backupInfo.count} ${backupInfo.count === 1 ? 'copy' : 'copies'}, `
                                              + `${KeepassDatabaseService.formatAttachmentSize(backupInfo.totalBytes)}`
                                              + `${backupInfo.newest ? `, newest ${new Date(backupInfo.newest).toLocaleString()}` : ''}`}
                                    </span>
                                    <button
                                        className="clear-cache-button"
                                        onClick={() => {
                                            const vaultPath = KeepassDatabaseService.getPath();
                                            if (vaultPath) window.electron?.revealBackups(vaultPath);
                                        }}
                                    >
                                        Open Folder
                                    </button>
                                </div>
                            )}
                        </div>
                        {contentProtection?.supported && (
                            <div className="content-protection-controls">
                                <div className="auto-lock-toggle">
                                    <label htmlFor="content-protection-enabled">Hide window from screen capture</label>
                                    <input
                                        type="checkbox"
                                        id="content-protection-enabled"
                                        checked={contentProtection.enabled}
                                        onChange={(e) => handleContentProtectionToggle(e.target.checked)}
                                    />
                                </div>
                                <p className="auto-lock-help">
                                    Keeps the window out of screenshots and screen shares, so an open vault
                                    is not caught on a call or a recording. Turn it off if you need to
                                    screenshot or screen share Vigil itself.
                                    {navigator.userAgent.includes('Mac') && ' On macOS this does not stop every recorder: apps built on ScreenCaptureKit can still capture the window.'}
                                </p>
                            </div>
                        )}
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
                                <p className="cache-help">Clears security report cache</p>
                            </div>
                        </div>
                    </div>
                    )}

                    {currentTab === 'security' && window.electron && (
                        <div className="settings-section">
                            <h3>Browser Integration</h3>
                            <div className="database-controls">
                                <div className="auto-lock-toggle">
                                    <label htmlFor="browser-integration-enabled">Enable KeePassXC-Browser support</label>
                                    <input
                                        type="checkbox"
                                        id="browser-integration-enabled"
                                        checked={!!browserIntegration?.enabled}
                                        disabled={!browserIntegration?.supported}
                                        onChange={(e) => handleBrowserIntegrationToggle(e.target.checked)}
                                    />
                                </div>
                                <p className="database-help">
                                    Lets the KeePassXC-Browser extension fill credentials from your vaults.
                                    Enabling registers Vigil with the browsers on this machine
                                    {browserIntegration?.running ? '; the connection server is running' : ''}
                                </p>
                                <div className="auto-lock-toggle">
                                    <label htmlFor="allow-passkeys-localhost">Allow passkeys on localhost</label>
                                    <input
                                        type="checkbox"
                                        id="allow-passkeys-localhost"
                                        checked={allowPasskeysLocalhost}
                                        onChange={(e) => {
                                            setAllowPasskeysLocalhost(e.target.checked);
                                            userSettingsService.setAllowPasskeysLocalhost(e.target.checked);
                                        }}
                                    />
                                </div>
                                <p className="database-help">
                                    Passkeys normally require https sites. Enable this only if you develop
                                    against locally hosted sites
                                </p>
                                {kdbxDb && browserAssociations.length > 0 && (
                                    <div className="browser-associations">
                                        <label>Connected browsers (this database)</label>
                                        {browserAssociations.map((association) => (
                                            <div key={association.name} className="browser-association-row">
                                                <span>{association.name}</span>
                                                <button
                                                    className="clear-cache-button"
                                                    onClick={() => handleRemoveAssociation(association.name)}
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {currentTab === 'general' && kdbxDb && (
                        <div className="settings-section">
                            <h3>Import</h3>
                            <div className="database-controls">
                                <button
                                    className="import-csv-button"
                                    onClick={() => setShowImportModal(true)}
                                >
                                    <ImportAuthIcon className="import-icon" />
                                    Import passwords
                                </button>
                                <p className="database-help">Import from Bitwarden (.json or .csv), KeePassXC, LastPass, 1Password, or a browser's CSV export; the format is detected automatically</p>
                            </div>
                        </div>
                    )}

                    {currentTab === 'general' && kdbxDb && window.electron && (
                        <div className="settings-section">
                            <h3>Export</h3>
                            <div className="database-controls">
                                <button
                                    className="import-csv-button"
                                    onClick={handleCsvExport}
                                >
                                    <DownloadActionIcon className="import-icon" />
                                    Export to CSV
                                </button>
                                <p className="database-help">Writes a KeePassXC-compatible CSV file. The file is unencrypted: every password in it is readable as plain text</p>
                            </div>
                        </div>
                    )}

                    {currentTab === 'general' && window.electron && (
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
                // Sits inside settings-overlay, whose click-outside handler
                // closes Settings; keep clicks in this modal to ourselves
                <div className="settings-modal-overlay" onClick={e => e.stopPropagation()}>
                    <div className="settings-import-modal">
                        <div className="settings-modal-header">
                            <h3>Import Passwords</h3>
                            <button
                                className="close-button"
                                onClick={() => setShowImportModal(false)}
                            >
                                <CloseActionIcon />
                            </button>
                        </div>
                        <div className="settings-modal-content">
                            <p>Select an export from your previous password manager.</p>
                            <p className="help-text">
                                Bitwarden (.json or .csv), LastPass, 1Password, and browser CSV exports
                                are detected automatically. Entries land in a new "Imported" group.
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
                                Select File
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
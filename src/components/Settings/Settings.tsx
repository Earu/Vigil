import { useTheme } from '../../contexts/ThemeContext';
import { CloseActionIcon, DownloadActionIcon } from '../../icons/actions/ActionIcons';
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from '../../icons/SettingsIcon';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import { LockIcon } from '../../icons/actions/LockIcon';
import { ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { userSettingsService, MIN_BACKUP_KEEP, MAX_BACKUP_KEEP, MIN_CLIPBOARD_CLEAR_SECONDS, MAX_CLIPBOARD_CLEAR_SECONDS, DEFAULT_CLIPBOARD_CLEAR_SECONDS } from '../../services/UserSettingsService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { ImportService } from '../../services/ImportService';
import { ExportService } from '../../services/ExportService';
import { BrowserIntegrationService } from '../../services/BrowserIntegrationService';
import { KeepassDatabaseService, PendingCredentialChange, KdfInfo } from '../../services/KeepassDatabaseService';
import { useState, useEffect } from 'react';
import * as kdbxweb from 'kdbxweb';
import { UpdateStatus, BackupInfo, SshAgentStatus } from '../../types/electron';
import { Modal } from '../Modal';
import { MasterKeyDialog } from '../MasterKeyDialog';
import { TabStrip, tabPanelProps } from '../TabStrip';
import { SHORTCUT_GROUPS, chordKeys } from '../../services/Shortcuts';
import { confirmDialog } from '../../services/Dialogs';
import './Settings.css';

const REPO_URL = 'https://github.com/Earu/Vigil';
const ISSUES_URL = `${REPO_URL}/issues`;
const RELEASES_URL = `${REPO_URL}/releases`;

// What each platform's biometric check is called where the user can see it
const BIOMETRIC_METHOD_NAMES: Record<string, string> = {
    'windows-hello': 'Windows Hello',
    'touch-id': 'Touch ID',
    'face-id': 'Face ID',
    'optic-id': 'Optic ID',
};

const openLink = (url: string) => {
    if (window.electron) window.electron.openExternal(url).catch(() => {});
    else window.open(url, '_blank', 'noopener');
};

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
    kdbxDb: kdbxweb.Kdbx | null;
    autoLockEnabled: boolean;
    setAutoLockEnabled: (enabled: boolean) => void;
    autoLockDuration: number;
    setAutoLockDuration: (duration: number) => void;
    // Resolves once the save has finished, true if it succeeded. Most callers
    // fire and forget; the password change waits on it
    // rekeyTo, when given, is a master password change for the save to apply
    // once it has merged whatever is on disk; see MasterPasswordChange
    onDatabaseChange?: (rekeyTo?: PendingCredentialChange) => void | Promise<boolean>;
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
        const refresh = () => window.electron!.getBackupInfo(vaultPath).then(setBackupInfo).catch(() => setBackupInfo(null));
        refresh();
        // The master key change offers to delete the copies that still open
        // with the old one
        window.addEventListener('vigil-backups-changed', refresh);
        return () => window.removeEventListener('vigil-backups-changed', refresh);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        setApiKey('');
        window.electron?.hasHibpApiKey?.().then(setHibpKeyStored).catch(() => setHibpKeyStored(false));
    }, [isOpen]);
    const { theme, setTheme } = useTheme();
    // The key itself lives in the OS keychain via the main process; this is
    // only what the user is currently typing, committed on blur or Enter
    const [apiKey, setApiKey] = useState('');
    const [hibpKeyStored, setHibpKeyStored] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [checkPasswordBreaches, setCheckPasswordBreaches] = useState<boolean>(userSettingsService.getCheckPasswordBreaches());
    const [showImportModal, setShowImportModal] = useState(false);
    const [fetchFavicons, setFetchFavicons] = useState<boolean>(userSettingsService.getFetchFavicons());
    const [clipboardClearSeconds, setClipboardClearSeconds] = useState<number>(userSettingsService.getClipboardClearSeconds());
    const [allowPasskeysLocalhost, setAllowPasskeysLocalhost] = useState<boolean>(userSettingsService.getAllowPasskeysLocalhost());
    const [alwaysAllowBrowserAccess, setAlwaysAllowBrowserAccess] = useState<boolean>(userSettingsService.getAlwaysAllowBrowserAccess());
    const [sshAgentEnabled, setSshAgentEnabled] = useState<boolean>(userSettingsService.getSshAgentEnabled());
    const [sshAgent, setSshAgent] = useState<SshAgentStatus | null>(null);
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
    const [dbName, setDbName] = useState('');
    const [dbDesc, setDbDesc] = useState('');
    const [showMasterKey, setShowMasterKey] = useState(false);
    const [kdfInfo, setKdfInfo] = useState<KdfInfo | null>(null);
    const [historyMax, setHistoryMax] = useState(10);
    const [activeTab, setActiveTab] = useState<'general' | 'database' | 'security'>('general');
    const [browserIntegration, setBrowserIntegration] = useState<{ supported: boolean; enabled: boolean; running: boolean } | null>(null);
    const [browserAssociations, setBrowserAssociations] = useState<Array<{ name: string; key: string }>>([]);
    const [contentProtection, setContentProtection] = useState<{ supported: boolean; enabled: boolean } | null>(null);
    // null until loaded, so the toggle never flashes a wrong default
    const [biometricsRestartLock, setBiometricsRestartLock] = useState<boolean | null>(null);
    // What the platform calls its biometric check, and null when this machine
    // (or this build) has no biometric unlock at all, which is what hides the
    // setting rather than a guess from the user agent
    const [biometricsMethod, setBiometricsMethod] = useState<string | null>(null);

    // Fresh dialog starts on the first tab; the Database tab disappears with
    // the database
    useEffect(() => {
        if (isOpen) setActiveTab('general');
        setShowMasterKey(false);
    }, [isOpen]);
    const currentTab = activeTab === 'database' && !kdbxDb ? 'general' : activeTab;

    // Seed the database settings form from the open database
    useEffect(() => {
        if (!isOpen || !kdbxDb) return;
        setDbName(kdbxDb.meta.name ?? '');
        setDbDesc(kdbxDb.meta.desc ?? '');
        setKdfInfo(KeepassDatabaseService.getKdfInfo(kdbxDb));
        setHistoryMax(KeepassDatabaseService.getHistoryMaxItems(kdbxDb));
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
        window.electron.sshAgentStatus?.().then(setSshAgent).catch(() => {});
        window.electron.getBiometricsConfig?.()
            .then(config => setBiometricsRestartLock(config.requirePasswordAfterRestart))
            .catch(() => {});
        window.electron.getBiometricsInfo()
            .then(info => setBiometricsMethod(info.available ? BIOMETRIC_METHOD_NAMES[info.biometryType] ?? 'Biometric' : null))
            .catch(() => {});
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

    const commitApiKey = async () => {
        const key = apiKey.trim();
        // An empty box next to a stored key is no change; removal is its own
        // button so a stray blur cannot silently drop the key
        if (!key) return;
        const result = await window.electron?.setHibpApiKey(key);
        if (result?.success) {
            setHibpKeyStored(true);
            setApiKey('');
            window.dispatchEvent(new Event('vigil-hibp-key-changed'));
            (window as any).showToast?.({ message: 'API key saved to the system keychain', type: 'success', duration: 3000 });
        } else {
            (window as any).showToast?.({ message: result?.error || 'Failed to store the API key', type: 'error', duration: 5000 });
        }
    };

    const removeApiKey = async () => {
        const result = await window.electron?.setHibpApiKey(null);
        if (result?.success) {
            setHibpKeyStored(false);
            window.dispatchEvent(new Event('vigil-hibp-key-changed'));
        } else {
            (window as any).showToast?.({ message: result?.error || 'Failed to remove the API key', type: 'error', duration: 5000 });
        }
    };

    const handleBiometricsRestartLockToggle = async (enabled: boolean) => {
        if (!window.electron) return;
        // Optimistic; turning the lock OFF may show one biometric prompt per
        // armed vault, the consent to write its password back to disk
        setBiometricsRestartLock(enabled);
        const result = await window.electron.setBiometricsConfig({ requirePasswordAfterRestart: enabled });
        if (!result.success) {
            setBiometricsRestartLock(!enabled);
            (window as any).showToast?.({ message: result.error || 'Failed to change the setting', type: 'error', duration: 5000 });
        }
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

    const handleRemoveAssociation = async (name: string) => {
        if (!kdbxDb) return;
        BrowserIntegrationService.removeAssociation(kdbxDb, name);
        setBrowserAssociations(BrowserIntegrationService.listAssociations(kdbxDb));
        await saveAndReport('Connection removed', 'The connection was removed here but not saved');
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

        const confirmed = await confirmDialog(
            `Export ${count} entries to an unencrypted CSV file?`
            + formulaWarning,
            'Export'
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

    const handleKdbxExport = async () => {
        if (!kdbxDb || !window.electron) return;
        try {
            const bytes = await KeepassDatabaseService.exportDatabaseCopy(kdbxDb);
            const result = await window.electron.saveAttachment(
                ExportService.kdbxCopyFileName(kdbxDb),
                new Uint8Array(bytes)
            );
            if (result.success) {
                (window as any).showToast?.({
                    message: `Encrypted copy saved to ${result.filePath}`,
                    type: 'success',
                    duration: 4000
                });
            } else if (result.error !== 'Save cancelled') {
                (window as any).showToast?.({
                    message: result.error || 'Failed to save the copy',
                    type: 'error',
                    duration: 5000
                });
            }
        } catch (err) {
            console.error('Failed to export database copy:', err);
            (window as any).showToast?.({
                message: 'Failed to export the database',
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
        input.accept = '.csv,.json,.xml,.1pux,.1pif';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const result = await ImportService.parseFile(file);

                const skippedNote = result.skipped > 0 ? ` (${result.skipped} unsupported items skipped)` : '';
                const confirmImport = await confirmDialog(
                    `Import ${result.entries.length} entries from ${result.source}${skippedNote}?`,
                    'Import'
                );
                if (!confirmImport) return;

                // onDatabaseChange performs the save; writing entries here and
                // saving there avoids a redundant second save
                await ImportService.writeEntries(result, kdbxDb);
                setShowImportModal(false);
                await saveAndReport(
                    `Imported ${result.entries.length} entries from ${result.source}`,
                    `Imported ${result.entries.length} entries from ${result.source}, but they were not saved`
                );
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
    const usesHardwareKey = !!kdbxDb && KeepassDatabaseService.usesHardwareKey(kdbxDb);

    const showSettingsToast = (message: string, type: 'success' | 'error' = 'success') => {
        (window as any).showToast?.({ message, type, duration: 3000 });
    };

    // A settings change is only worth announcing once it has reached the file.
    // The save path has already said what went wrong, so a failure here only
    // has to withdraw the claim that anything was applied. The edit stays in
    // the model either way and rides the next successful save, which is what
    // the unsaved-changes guards are for
    const saveAndReport = async (success: string, failure: string, rekeyTo?: PendingCredentialChange): Promise<boolean> => {
        const saved = (await onDatabaseChange?.(rekeyTo)) === true;
        showSettingsToast(saved ? success : failure, saved ? 'success' : 'error');
        return saved;
    };

    const handleApplyDetails = () => {
        if (!kdbxDb || !dbName.trim()) return;
        kdbxDb.meta.name = dbName.trim();
        kdbxDb.meta.desc = dbDesc;
        void saveAndReport('Database details saved', 'The database details were not saved');
    };

    const handleApplyKdf = () => {
        if (!kdbxDb || !kdfInfo) return;
        if (KeepassDatabaseService.argon2WorkExceeded(kdfInfo)) {
            const budget = KeepassDatabaseService.ARGON2_MAX_WORK_MIB_PASSES;
            (window as any).showToast?.({
                message: `Memory times iterations may not exceed ${budget.toLocaleString()} MiB; a vault past that would take too long to unlock`,
                type: 'error'
            });
            return;
        }
        if (KeepassDatabaseService.aesRoundsExceeded(kdfInfo)) {
            (window as any).showToast?.({
                message: `Encryption rounds may not exceed ${KeepassDatabaseService.MAX_AES_KDF_ROUNDS.toLocaleString()}; a vault past that would take too long to unlock`,
                type: 'error'
            });
            return;
        }
        KeepassDatabaseService.setKdf(kdbxDb, kdfInfo);
        setKdfInfo(KeepassDatabaseService.getKdfInfo(kdbxDb));
        void saveAndReport('Key derivation settings applied', 'The key derivation settings were not saved');
    };

    const handleApplyHistory = () => {
        if (!kdbxDb) return;
        KeepassDatabaseService.setHistoryMaxItems(kdbxDb, historyMax);
        void saveAndReport('History retention updated', 'The history retention setting was not saved');
    };

    return (
        <Modal
            overlayClassName="settings-overlay"
            className="settings-dialog"
            labelledBy="settings-title"
            onClose={onClose}
            closeOnOverlayClick
            initialFocus="container"
        >
                <div className="settings-header">
                    <h2 id="settings-title">Settings</h2>
                    <button className="close-button" onClick={onClose} aria-label="Close settings">
                        <CloseActionIcon />
                    </button>
                </div>
                <TabStrip
                    idPrefix="settings"
                    label="Settings sections"
                    tabs={[
                        { id: 'general' as const, label: 'General' },
                        ...(kdbxDb ? [{ id: 'database' as const, label: 'Database' }] : []),
                        { id: 'security' as const, label: 'Security' },
                    ]}
                    active={currentTab}
                    onChange={setActiveTab}
                    className="settings-tabs"
                    tabClassName="settings-tab"
                />
                <div className="settings-content" {...tabPanelProps('settings', currentTab)}>
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
                            <div className="master-key-controls">
                                <label>Master key</label>
                                <p className="database-help">
                                    Unlocked by {[
                                        'password',
                                        hasKeyFile ? 'key file' : null,
                                        usesHardwareKey ? 'hardware key' : null
                                    ].filter(Boolean).join(' + ')}.
                                </p>
                                <div className="db-apply-row">
                                    <button className="settings-secondary-button" onClick={() => setShowMasterKey(true)}>
                                        Change master key
                                    </button>
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
                                                max={KeepassDatabaseService.MAX_AES_KDF_ROUNDS}
                                                value={kdfInfo.iterations}
                                                onChange={(e) => setKdfInfo({ ...kdfInfo, iterations: Math.max(1, Math.min(KeepassDatabaseService.MAX_AES_KDF_ROUNDS, parseInt(e.target.value) || 1)) })}
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
                            <p className="auto-lock-help">Locks the database after this long without activity</p>
                        </div>
                        <div className="clipboard-clear-controls">
                            <div className="auto-lock-duration enabled">
                                <label htmlFor="clipboard-clear-seconds">Clear clipboard after (seconds)</label>
                                <input
                                    type="number"
                                    id="clipboard-clear-seconds"
                                    value={clipboardClearSeconds}
                                    min={MIN_CLIPBOARD_CLEAR_SECONDS}
                                    max={MAX_CLIPBOARD_CLEAR_SECONDS}
                                    onChange={(e) => {
                                        const value = Math.max(MIN_CLIPBOARD_CLEAR_SECONDS, Math.min(MAX_CLIPBOARD_CLEAR_SECONDS, parseInt(e.target.value) || DEFAULT_CLIPBOARD_CLEAR_SECONDS));
                                        setClipboardClearSeconds(value);
                                        userSettingsService.setClipboardClearSeconds(value);
                                    }}
                                />
                            </div>
                            <p className="auto-lock-help">A copied password or username is wiped from the clipboard after this long</p>
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
                        {biometricsMethod && biometricsRestartLock !== null && (
                            <div className="content-protection-controls">
                                <div className="auto-lock-toggle">
                                    <label htmlFor="biometrics-restart-lock">Require master password each time Vigil starts</label>
                                    <input
                                        type="checkbox"
                                        id="biometrics-restart-lock"
                                        checked={biometricsRestartLock}
                                        onChange={(e) => handleBiometricsRestartLockToggle(e.target.checked)}
                                    />
                                </div>
                                <p className="auto-lock-help">
                                    Type your master password once each time you open Vigil. {biometricsMethod} then
                                    unlocks it until you quit. Turning this off lets {biometricsMethod} work right
                                    away, but Vigil has to keep an unlock key stored on this computer for that.
                                </p>
                            </div>
                        )}
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
                                    Keeps the window out of screenshots and screen shares. Turn it off
                                    if you need to screenshot or screen share Vigil itself.
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
                        <div className="favicon-controls">
                            <div className="auto-lock-toggle">
                                <label htmlFor="check-password-breaches">Check passwords against Have I Been Pwned</label>
                                <input
                                    type="checkbox"
                                    id="check-password-breaches"
                                    checked={checkPasswordBreaches}
                                    onChange={(e) => {
                                        setCheckPasswordBreaches(e.target.checked);
                                        userSettingsService.setCheckPasswordBreaches(e.target.checked);
                                    }}
                                />
                            </div>
                            <p className="auto-lock-help">Runs on unlock using k-anonymity: only the first 5 characters of each password's SHA-1 hash leave the machine</p>
                        </div>
                        <div className="api-key-input">
                            <label htmlFor="hibp-api-key">Have I Been Pwned API Key</label>
                            <div className={`input-with-toggle${hibpKeyStored ? ' key-locked' : ''}`}>
                                <input
                                    type={showApiKey ? 'text' : 'password'}
                                    id="hibp-api-key"
                                    value={apiKey}
                                    disabled={hibpKeyStored}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    onBlur={() => void commitApiKey()}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void commitApiKey(); }}
                                    placeholder={hibpKeyStored ? '***************************' : 'Enter your HIBP API key'}
                                />
                                {hibpKeyStored ? (
                                    <div className="key-locked-overlay" title="Stored in the system keychain">
                                        <LockIcon />
                                    </div>
                                ) : (
                                    <button
                                        className="toggle-visibility"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        type="button"
                                    >
                                        {showApiKey ? <HidePasswordIcon /> : <ShowPasswordIcon />}
                                    </button>
                                )}
                            </div>
                            {hibpKeyStored && (
                                <button className="clear-cache-button" onClick={() => void removeApiKey()} type="button">
                                    Remove API Key
                                </button>
                            )}
                            <p className="api-key-help">
                                Enables email breach checks. Get your API key from{' '}
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
                            {window.electron && (
                                <div className="cache-controls">
                                    <button
                                        className="clear-cache-button"
                                        onClick={() => {
                                            window.electron?.revealLogs().then((result) => {
                                                if (!result.success) {
                                                    (window as any).showToast?.({
                                                        message: result.error || 'Failed to open the log folder',
                                                        type: 'error',
                                                        duration: 3000
                                                    });
                                                }
                                            });
                                        }}
                                    >
                                        Show Logs
                                    </button>
                                    <p className="cache-help">Opens the diagnostic log folder, useful for bug reports</p>
                                </div>
                            )}
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
                                    <label htmlFor="always-allow-browser-access">Always allow access to entries</label>
                                    <input
                                        type="checkbox"
                                        id="always-allow-browser-access"
                                        checked={alwaysAllowBrowserAccess}
                                        onChange={(e) => {
                                            setAlwaysAllowBrowserAccess(e.target.checked);
                                            userSettingsService.setAlwaysAllowBrowserAccess(e.target.checked);
                                        }}
                                    />
                                </div>
                                <p className="database-help">
                                    Skips the confirmation when the extension requests credentials.
                                    Anything holding a pairing key can then read matching entries
                                    silently; entries you denied stay denied
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

                    {currentTab === 'security' && window.electron && (
                        <div className="settings-section">
                            <h3>SSH Agent</h3>
                            <div className="database-controls">
                                <div className="auto-lock-toggle">
                                    <label htmlFor="ssh-agent-enabled">Add stored SSH keys to the agent on unlock</label>
                                    <input
                                        type="checkbox"
                                        id="ssh-agent-enabled"
                                        checked={sshAgentEnabled}
                                        onChange={(e) => {
                                            setSshAgentEnabled(e.target.checked);
                                            userSettingsService.setSshAgentEnabled(e.target.checked);
                                        }}
                                    />
                                </div>
                                <p className="database-help">
                                    Private keys attached to entries and marked for the agent are loaded into
                                    the ssh-agent this machine already runs when a vault opens, and removed
                                    when it locks. The entry password is the key passphrase. Entries are set
                                    up in their SSH Agent field.
                                    {sshAgent && (sshAgent.running
                                        ? ` Agent found${sshAgent.socketPath ? ` at ${sshAgent.socketPath}` : ''}.`
                                        : ' No agent found: SSH_AUTH_SOCK is not set or the socket is gone.')}
                                </p>
                                {sshAgent && sshAgent.identities.length > 0 && (
                                    <div className="browser-associations">
                                        <label>Keys in the agent</label>
                                        {sshAgent.identities.map((identity) => (
                                            <div key={identity.fingerprint} className="browser-association-row ssh-agent-identity">
                                                <span title={identity.fingerprint}>{identity.comment || identity.type}</span>
                                                {!sshAgent.addedByVigil.includes(identity.fingerprint) && (
                                                    <span className="ssh-agent-origin" title="Loaded by something other than Vigil; a lock leaves it alone">not from Vigil</span>
                                                )}
                                                <span className="ssh-agent-fingerprint" title={identity.fingerprint}>{identity.fingerprint}</span>
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
                                    onClick={handleKdbxExport}
                                >
                                    <DownloadActionIcon className="import-icon" />
                                    Save encrypted copy
                                </button>
                                <p className="database-help">Writes the database to a .kdbx file, encrypted with the same credentials</p>
                                <button
                                    className="import-csv-button"
                                    onClick={handleCsvExport}
                                >
                                    <DownloadActionIcon className="import-icon" />
                                    Export to CSV
                                </button>
                                <p className="database-help">Writes an unencrypted CSV file with every password in plain text</p>
                            </div>
                        </div>
                    )}

                    {currentTab === 'general' && (
                        <div className="settings-section">
                            <h3>About</h3>
                            <div className="info-about">
                                <p className="info-version">Vigil {__APP_VERSION__}</p>
                                <p className="auto-lock-help">A password manager for KeePass vaults. Free software under the GPL-3.0 licence.</p>
                                <div className="info-links">
                                    <button className="clear-cache-button" onClick={() => openLink(ISSUES_URL)}>Report a bug</button>
                                    <button className="clear-cache-button" onClick={() => openLink(RELEASES_URL)}>Release notes</button>
                                    <button className="clear-cache-button" onClick={() => openLink(REPO_URL)}>Source code</button>
                                </div>
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
                                <p className="auto-lock-help">Downloaded updates install automatically when the app closes.</p>
                            </div>
                        </div>
                    )}

                    {currentTab === 'general' && (
                        <div className="settings-section">
                            <h3>Keyboard shortcuts</h3>
                            <div className="shortcut-groups">
                                {SHORTCUT_GROUPS.map((group) => (
                                    <table className="shortcut-table" key={group.title}>
                                        <caption>{group.title}</caption>
                                        <tbody>
                                            {group.rows.map((row) => (
                                                <tr key={row.chord}>
                                                    <th scope="row">
                                                        {chordKeys(row.chord).map((key, i) => (
                                                            <span key={i}>{i > 0 && ' '}<kbd>{key}</kbd></span>
                                                        ))}
                                                    </th>
                                                    <td>{row.label}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

            {showImportModal && (
                <Modal
                    overlayClassName="settings-modal-overlay"
                    className="settings-import-modal"
                    labelledBy="settings-import-title"
                    onClose={() => setShowImportModal(false)}
                >
                        <div className="settings-modal-header">
                            <h3 id="settings-import-title">Import Passwords</h3>
                            <button
                                className="close-button"
                                onClick={() => setShowImportModal(false)}
                                aria-label="Close import dialog"
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
                </Modal>
            )}
            {showMasterKey && kdbxDb && (
                <MasterKeyDialog
                    kdbxDb={kdbxDb}
                    onSave={(rekeyTo) => Promise.resolve(onDatabaseChange?.(rekeyTo)).then(saved => saved === true)}
                    onClose={() => setShowMasterKey(false)}
                />
            )}
        </Modal>
    );
}
import { useState, useEffect } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Database } from '../../types/database';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { LockAuthIcon, BiometricAuthIcon, ShowPasswordIcon, HidePasswordIcon, UnlockAuthIcon } from '../../icons/auth/AuthIcons';
import { KeyActionIcon } from '../../icons/actions/ActionIcons';
import { SpinnerIcon } from '../../icons/status/StatusIcons';
import { userSettingsService } from '../../services/UserSettingsService';

interface PasswordFormProps {
    selectedFile: File | null;
    isCreatingNew: boolean;
    databasePath: string | null;
    error: string | null;
    setError: (error: string | null) => void;
    setSelectedFile: (file: File | null) => void;
    onDatabaseOpen: (database: Database, db: kdbxweb.Kdbx, showBreachReport?: boolean) => void;
    onBreachCheckComplete: () => void;
    passwordInputRef: React.RefObject<HTMLInputElement>;
    setIsCreatingNew: (isCreating: boolean) => void;
    initialBiometricsEnabled: boolean;
    browserPasswords?: Array<{ url: string; username: string; password: string }>;
    setBrowserPasswords?: (passwords: Array<{ url: string; username: string; password: string }> | undefined) => void;
}

export const PasswordForm = ({
    selectedFile,
    isCreatingNew,
    databasePath,
    error,
    setError,
    setSelectedFile,
    onDatabaseOpen,
    onBreachCheckComplete,
    passwordInputRef,
    setIsCreatingNew,
    initialBiometricsEnabled,
    browserPasswords,
    setBrowserPasswords
}: PasswordFormProps) => {
    const [showPassword, setShowPassword] = useState(false);
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [confirmPassword, setConfirmPassword] = useState('');
    const [databaseName, setDatabaseName] = useState('New Database');
    const [isBiometricsEnabled, setIsBiometricsEnabled] = useState(initialBiometricsEnabled);
    const [isBiometricsAvailable, setIsBiometricsAvailable] = useState(false);
    const [showPasswordInput, setShowPasswordInput] = useState(!initialBiometricsEnabled);
    const [keyFile, setKeyFile] = useState<{ path: string; name: string } | null>(null);

    const keyFileName = (path: string) => path.split(/[/\\]/).pop() || path;

    useEffect(() => {
        if (databasePath) {
            const remembered = userSettingsService.getKeyFilePath(databasePath);
            setKeyFile(remembered ? { path: remembered, name: keyFileName(remembered) } : null);
        } else {
            setKeyFile(null);
        }
    }, [databasePath]);

    const buildCredentials = async (passwordStr: string): Promise<kdbxweb.Credentials> => {
        if (!keyFile) {
            return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(passwordStr));
        }
        const result = await window.electron?.readFile(keyFile.path);
        if (!result?.success || !result.data) {
            throw new Error('KEYFILE_READ_FAILED');
        }
        // Copy into a fresh, exactly-sized buffer before handing it to kdbxweb
        const keyFileData = new Uint8Array(result.data).buffer;
        return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(passwordStr), keyFileData);
    };

    const rememberKeyFile = (dbPath: string | null | undefined) => {
        if (dbPath) {
            userSettingsService.setKeyFilePath(dbPath, keyFile?.path);
        }
    };

    const handleSelectKeyFile = async () => {
        const result = await window.electron?.selectKeyFile();
        if (result?.filePath) {
            setKeyFile({ path: result.filePath, name: keyFileName(result.filePath) });
            setError('');
        }
    };

    const unlockError = (err: unknown): string => {
        if (err instanceof Error && err.message === 'KEYFILE_READ_FAILED') {
            return `Failed to read key file ${keyFile?.path}`;
        }
        return keyFile
            ? 'Invalid password or key file'
            : 'Invalid password or corrupted database file';
    };

    useEffect(() => {
        const checkBiometrics = async () => {
            if (!window.electron) return;
            const available = await window.electron.isBiometricsAvailable();
            setIsBiometricsAvailable(available);
        };
        checkBiometrics();
    }, []);

    useEffect(() => {
        setIsBiometricsEnabled(initialBiometricsEnabled);
        setShowPasswordInput(!initialBiometricsEnabled);
    }, [initialBiometricsEnabled]);

    useEffect(() => {
        if (selectedFile) {
            passwordInputRef.current?.focus();
        }
    }, [selectedFile, passwordInputRef]);

    const startBreachCheck = async (database: Database, _db: kdbxweb.Kdbx, databasePath: string) => {
        // Check cache status
        const {
            breached: breachedPasswords,
            weak: weakPasswords,
            hasCheckedEntries: hasCheckedPasswordEntries,
            allEntriesCached: allPasswordEntriesCached
        } = BreachCheckService.findBreachedAndWeakEntries(database.root);

        const {
            breached: breachedEmails,
            hasCheckedEmails: hasCheckedEmailEntries,
            allEmailsCached: allEmailEntriesCached
        } = BreachCheckService.findBreachedEmails(database.root);

        // If we have any cached results with breaches, show them immediately
        if (breachedPasswords.length > 0 || weakPasswords.length > 0 || breachedEmails.length > 0) {
            onBreachCheckComplete();
        }

        // Run both checks in parallel if needed
        await Promise.all([
            // Check passwords
            (async () => {
                if (hasCheckedPasswordEntries && !allPasswordEntriesCached) {
                    const hasBreaches = await BreachCheckService.checkGroup(databasePath, database.root);
                    if (hasBreaches && KeepassDatabaseService.getPath() === databasePath) {
                        window.electron?.showNotification({
                            title: 'Password Security Alert',
                            body: `Some passwords in ${databasePath} were found in data breaches`
                        });
                    }
                }
            })(),
            // Check emails
            (async () => {
                const hasApikey = userSettingsService.getHibpApiKey() != null;
                if (hasCheckedEmailEntries && !allEmailEntriesCached && hasApikey) {
                    const hasBreaches = await BreachCheckService.checkGroupEmails(databasePath, database.root);
                    if (hasBreaches && KeepassDatabaseService.getPath() === databasePath) {
                        window.electron?.showNotification({
                            title: 'Email Security Alert',
                            body: `Some emails in ${databasePath} were found in data breaches`
                        });
                    }
                }
            })()
        ]);

        // Only surface the report if the database hasn't been locked in the
        // meantime. Do NOT re-call onDatabaseOpen here: the database object
        // captured at unlock time is stale by now and would wipe out any
        // entries the user added while the checks were running.
        if (KeepassDatabaseService.getPath() === databasePath) {
            onBreachCheckComplete();
        }
    }

    const handleBiometricUnlock = async () => {
        if (!selectedFile || !databasePath || !window.electron || !isBiometricsEnabled) return;

        setIsLoading(true);
        setError('');

        try {
            const biometricResult = await window.electron.getBiometricPassword(databasePath);
            if (!biometricResult.success || !biometricResult.password) {
                await window.electron.disableBiometrics(databasePath);
                setIsBiometricsEnabled(false);
                setShowPasswordInput(true);
                (window as any).showToast?.({
                    message: 'Switched to password authentication',
                    type: 'info'
                });
                throw new Error('Failed to get biometric password');
            }

            const result = await window.electron.readFile(databasePath);
            if (!result.success || !result.data) {
                throw new Error(result.error || 'Failed to read file');
            }

            const credentials = await buildCredentials(biometricResult.password);

            const db = await kdbxweb.Kdbx.load(
                new Uint8Array(result.data.buffer).buffer,
                credentials
            );

            const database = KeepassDatabaseService.convertKdbxToDatabase(db);
            KeepassDatabaseService.setPath(databasePath);
            rememberKeyFile(databasePath);
            onDatabaseOpen(database, db);

            await startBreachCheck(database, db, databasePath);
            await window.electron.saveLastDatabasePath(databasePath);
        } catch (err) {
            console.error('Failed to unlock database with biometrics:', err);
            if (!isBiometricsEnabled) {
                setError('Biometric authentication failed');
            }
            setShowPasswordInput(true);
        } finally {
            setIsLoading(false);
        }
    };

    const handleBiometricsToggle = async () => {
        if (!window.electron || !databasePath) return;

        if (isBiometricsEnabled) {
            const result = await window.electron.disableBiometrics(databasePath);
            if (result.success) {
                setIsBiometricsEnabled(false);
                setShowPasswordInput(true);
                (window as any).showToast?.({
                    message: 'Biometric authentication disabled',
                    type: 'success'
                });
            } else {
                (window as any).showToast?.({
                    message: 'Failed to disable biometric authentication',
                    type: 'error'
                });
            }
        } else {
            if (!password) {
                setError('Please enter your database password to enable biometric authentication');
                return;
            }

            try {
                const credentials = await buildCredentials(password);
                let fileBuffer: ArrayBuffer;
                if (databasePath && window.electron) {
                    const result = await window.electron.readFile(databasePath);
                    if (!result.success || !result.data) {
                        throw new Error(result.error || 'Failed to read file');
                    }
                    fileBuffer = result.data.buffer;
                } else {
                    fileBuffer = await selectedFile!.arrayBuffer();
                }

                await kdbxweb.Kdbx.load(
                    new Uint8Array(fileBuffer).buffer,
                    credentials
                );

                const result = await window.electron.enableBiometrics(databasePath, password);
                if (result.success) {
                    setIsBiometricsEnabled(true);
                    setShowPasswordInput(false);
                    setPassword('');
                    (window as any).showToast?.({
                        message: 'Biometric authentication enabled',
                        type: 'success'
                    });
                    handleUnlock();
                } else {
                    (window as any).showToast?.({
                        message: result.error || 'Failed to enable biometric authentication',
                        type: 'error'
                    });
                }
            } catch (err) {
                setError('Invalid database password');
            }
        }
    };

    const handleUnlock = async () => {
        if (!selectedFile) return;

        setIsLoading(true);
        setError('');

        try {
            let fileBuffer: ArrayBuffer;
            let credentials: kdbxweb.Credentials;

            if (databasePath && window.electron) {
                if (isBiometricsEnabled) {
                    const biometricResult = await window.electron.getBiometricPassword(databasePath);
                    if (biometricResult.success && biometricResult.password) {
                        credentials = await buildCredentials(biometricResult.password);
                    } else {
                        credentials = await buildCredentials(password);
                    }
                } else {
                    credentials = await buildCredentials(password);
                }

                const result = await window.electron.readFile(databasePath);
                if (!result.success || !result.data) {
                    throw new Error(result.error || 'Failed to read file');
                }
                fileBuffer = result.data.buffer;
                await window.electron.saveLastDatabasePath(databasePath);
                KeepassDatabaseService.setPath(databasePath);
            } else {
                fileBuffer = await selectedFile.arrayBuffer();
                credentials = await buildCredentials(password);
            }

            const db = await kdbxweb.Kdbx.load(
                new Uint8Array(fileBuffer).buffer,
                credentials
            );

            const database = KeepassDatabaseService.convertKdbxToDatabase(db);
            rememberKeyFile(databasePath);
            onDatabaseOpen(database, db);

            // Start breach checking in the background
            if (databasePath) {
                await startBreachCheck(database, db, databasePath);
            }
        } catch (err) {
            console.error('Failed to unlock database:', err);
            setError(unlockError(err));
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateNew = async () => {
        if (password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }
        if (password.length < 8) {
            setError('Password must be at least 8 characters long');
            return;
        }
        if (!databaseName.trim()) {
            setError('Database name is required');
            return;
        }

        setIsLoading(true);
        setError('');

        try {
            const credentials = await buildCredentials(password);
            const db = kdbxweb.Kdbx.create(credentials, databaseName.trim());

            // Import browser passwords if they exist
            if (browserPasswords?.length && browserPasswords.length > 0) {
                const importedGroup = db.createGroup(db.getDefaultGroup(), 'Imported');
                for (const browserPassword of browserPasswords) {
                    const entry = db.createEntry(importedGroup);
                    entry.fields.set('Title', new URL(browserPassword.url).hostname);
                    entry.fields.set('UserName', browserPassword.username);
                    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(browserPassword.password));
                    entry.fields.set('URL', browserPassword.url);
                }
                // Clear the imported passwords
                setBrowserPasswords?.(undefined);
            }

            const arrayBuffer = await db.save();
            const result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));

            if (!result?.success) {
                throw new Error(result?.error || 'Failed to save database');
            }

            if (result.filePath) {
                await window.electron?.saveLastDatabasePath(result.filePath);
                KeepassDatabaseService.setPath(result.filePath);
                rememberKeyFile(result.filePath);
            }

            onDatabaseOpen(KeepassDatabaseService.convertKdbxToDatabase(db), db);
        } catch (err) {
            console.error('Failed to create database:', err);
            setError(err instanceof Error ? err.message : 'Failed to create database');
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !isLoading) {
            if (isCreatingNew) {
                handleCreateNew();
            } else if (selectedFile) {
                handleUnlock();
            }
        }
    };

    return (
        <div className="password-form">
            {selectedFile && (
                <div className="selected-file">
                    <span>{selectedFile.name}</span>
                    <button
                        className="clear-file"
                        onClick={() => {
                            setSelectedFile(null);
                            setError('');
                        }}
                        title="Clear selection"
                    >
                        ×
                    </button>
                </div>
            )}

            {isCreatingNew && (
                <div className="input-container">
                    <input
                        type="text"
                        placeholder="Database name"
                        className="text-input"
                        value={databaseName}
                        onChange={(e) => setDatabaseName(e.target.value)}
                        onKeyPress={handleKeyPress}
                    />
                </div>
            )}

            {(selectedFile || isCreatingNew) && window.electron && (
                keyFile ? (
                    <div className="key-file-chip" title={keyFile.path}>
                        <KeyActionIcon className="key-file-icon" />
                        <span className="key-file-name">{keyFile.name}</span>
                        <button
                            className="clear-file"
                            onClick={() => {
                                setKeyFile(null);
                                setError('');
                            }}
                            title="Remove key file"
                        >
                            ×
                        </button>
                    </div>
                ) : (
                    <button className="add-key-file" onClick={handleSelectKeyFile} type="button">
                        <KeyActionIcon className="key-file-icon" />
                        Key file (optional)
                    </button>
                )
            )}

            {selectedFile && !isCreatingNew && isBiometricsAvailable && (
                <>
                    <div className="auth-toggle">
                        <button
                            className={`auth-option ${!isBiometricsEnabled || showPasswordInput ? 'active' : ''}`}
                            onClick={async () => {
                                if (isBiometricsEnabled) {
                                    const result = await window.electron?.disableBiometrics(databasePath!);
                                    if (result?.success) {
                                        setIsBiometricsEnabled(false);
                                        setShowPasswordInput(true);
                                        (window as any).showToast?.({
                                            message: 'Switched to password authentication',
                                            type: 'success'
                                        });
                                    }
                                }
                                setShowPasswordInput(true);
                            }}
                        >
                            <LockAuthIcon className="auth-icon" />
                            Password
                        </button>
                        <button
                            className={`auth-option ${isBiometricsEnabled && !showPasswordInput ? 'active' : ''}`}
                            onClick={() => {
                                if (!isBiometricsEnabled) {
                                    setShowPasswordInput(true);
                                    handleBiometricsToggle();
                                } else {
                                    setShowPasswordInput(false);
                                    handleBiometricUnlock();
                                }
                            }}
                        >
                            <BiometricAuthIcon className="auth-icon" />
                            {navigator.userAgent.includes('Mac') ? 'Touch ID' : (navigator.userAgent.includes('Windows') ? 'Windows Hello' : 'Biometrics')}
                        </button>
                    </div>

                    {isBiometricsEnabled && !showPasswordInput && (
                        <button
                            className="biometric-unlock-button"
                            onClick={handleBiometricUnlock}
                            disabled={isLoading}
                        >
                            <BiometricAuthIcon className="biometric-icon" />
                            {navigator.userAgent.includes('Mac') ? 'Unlock with Touch ID' : (navigator.userAgent.includes('Windows') ? 'Unlock with Windows Hello' : 'Unlock with Biometrics')}
                        </button>
                    )}
                </>
            )}

            {(!isBiometricsAvailable || showPasswordInput || !isBiometricsEnabled || isCreatingNew) && (
                <>
                    <div className="password-input-container">
                        <input
                            type={showPassword ? 'text' : 'password'}
                            placeholder={isCreatingNew ? "Create password" : "Enter password"}
                            className="password-input"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            ref={passwordInputRef}
                            onKeyPress={handleKeyPress}
                        />
                        <button
                            className="toggle-password"
                            onClick={() => setShowPassword(!showPassword)}
                            type="button"
                            title={showPassword ? 'Hide password' : 'Show password'}
                        >
                            {showPassword ? <HidePasswordIcon /> : <ShowPasswordIcon />}
                        </button>
                    </div>

                    {isCreatingNew && (
                        <div className="password-input-container">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                placeholder="Confirm password"
                                className="password-input"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                onKeyPress={handleKeyPress}
                            />
                        </div>
                    )}

                    {error && <div className="error-message">{error}</div>}

                    <div className="form-buttons">
                        {isCreatingNew && (
                            <button
                                className="cancel-button"
                                onClick={() => {
                                    setIsCreatingNew(false);
                                    setSelectedFile(null);
                                    setPassword('');
                                    setConfirmPassword('');
                                    setDatabaseName('New Database');
                                    setError('');
                                }}
                            >
                                Cancel
                            </button>
                        )}
                        <button
                            className={`unlock-button ${isLoading ? 'loading' : ''}`}
                            onClick={isCreatingNew ? handleCreateNew : handleUnlock}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <SpinnerIcon className="spinner" />
                            ) : (
                                <>
                                    <UnlockAuthIcon className="unlock-icon" />
                                    {isCreatingNew ? 'Create Database' : 'Unlock with Password'}
                                </>
                            )}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
};
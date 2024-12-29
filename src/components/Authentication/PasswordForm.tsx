import { useState, useEffect } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Database } from '../../types/database';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';

interface PasswordFormProps {
    selectedFile: File | null;
    isCreatingNew: boolean;
    databasePath: string | null;
    error: string | null;
    setError: (error: string | null) => void;
    setSelectedFile: (file: File | null) => void;
    onDatabaseOpen: (database: Database, db: kdbxweb.Kdbx, showBreachReport?: boolean) => void;
    passwordInputRef: React.RefObject<HTMLInputElement>;
    setIsCreatingNew: (isCreating: boolean) => void;
    initialBiometricsEnabled: boolean;
}

export const PasswordForm = ({
    selectedFile,
    isCreatingNew,
    databasePath,
    error,
    setError,
    setSelectedFile,
    onDatabaseOpen,
    passwordInputRef,
    setIsCreatingNew,
    initialBiometricsEnabled
}: PasswordFormProps) => {
    const [showPassword, setShowPassword] = useState(false);
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [confirmPassword, setConfirmPassword] = useState('');
    const [databaseName, setDatabaseName] = useState('New Database');
    const [isBiometricsEnabled, setIsBiometricsEnabled] = useState(initialBiometricsEnabled);
    const [isBiometricsAvailable, setIsBiometricsAvailable] = useState(false);
    const [showPasswordInput, setShowPasswordInput] = useState(!initialBiometricsEnabled);

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

            const credentials = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString(biometricResult.password)
            );

            const db = await kdbxweb.Kdbx.load(
                new Uint8Array(result.data.buffer).buffer,
                credentials
            );

            const database = KeepassDatabaseService.convertKdbxToDatabase(db);
            KeepassDatabaseService.setPath(databasePath);
            onDatabaseOpen(database, db);

            // Check cache status
            const { breached, weak, hasCheckedEntries, allEntriesCached } = BreachCheckService.findBreachedAndWeakEntries(database.root);

            // If we have any cached results with breaches, show them immediately
            if (breached.length > 0 || weak.length > 0) {
                onDatabaseOpen(database, db, true);
            }

            // Only run full check if we have entries but not all are cached
            if (hasCheckedEntries && !allEntriesCached) {
                const hasBreaches = await BreachCheckService.checkGroup(databasePath, database.root);
                if (hasBreaches) {
                    (window as any).showToast?.({
                        message: 'Some passwords in this database were found in data breaches',
                        type: 'warning',
                        duration: 10000
                    });
                    onDatabaseOpen(database, db, true);
                }
            }

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
                const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
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
                        credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(biometricResult.password));
                    } else {
                        credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
                    }
                } else {
                    credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
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
                credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
            }

            const db = await kdbxweb.Kdbx.load(
                new Uint8Array(fileBuffer).buffer,
                credentials
            );

            const database = KeepassDatabaseService.convertKdbxToDatabase(db);
            onDatabaseOpen(database, db);

            // Start breach checking in the background
            if (databasePath) {
                // Check cache status
                const { breached, weak, hasCheckedEntries, allEntriesCached } = BreachCheckService.findBreachedAndWeakEntries(database.root);

                // If we have any cached results with breaches, show them immediately
                if (breached.length > 0 || weak.length > 0) {
                    onDatabaseOpen(database, db, true);
                }

                // Only run full check if we have entries but not all are cached
                if (hasCheckedEntries && !allEntriesCached) {
                    const hasBreaches = await BreachCheckService.checkGroup(databasePath, database.root);
                    if (hasBreaches) {
                        (window as any).showToast?.({
                            message: 'Some passwords in this database were found in data breaches',
                            type: 'warning',
                            duration: 10000
                        });
                        onDatabaseOpen(database, db, true);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to unlock database:', err);
            setError('Invalid password or corrupted database file');
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
            const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
            const db = kdbxweb.Kdbx.create(credentials, databaseName.trim());

            const arrayBuffer = await db.save();
            const result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));

            if (!result?.success) {
                throw new Error(result?.error || 'Failed to save database');
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
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="auth-icon"
                            >
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
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
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="auth-icon"
                            >
                                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/>
                                <path d="M12 6c-1.7 0-3 1.3-3 3v1c0 1.7 1.3 3 3 3s3-1.3 3-3V9c0-1.7-1.3-3-3-3z"/>
                                <path d="M18 12c0 3.3-2.7 6-6 6s-6-2.7-6-6"/>
                            </svg>
                            {navigator.userAgent.includes('Mac') ? 'Touch ID' : 'Windows Hello'}
                        </button>
                    </div>

                    {isBiometricsEnabled && !showPasswordInput && (
                        <button
                            className="biometric-unlock-button"
                            onClick={handleBiometricUnlock}
                            disabled={isLoading}
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="biometric-icon"
                            >
                                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/>
                                <path d="M12 6c-1.7 0-3 1.3-3 3v1c0 1.7 1.3 3 3 3s3-1.3 3-3V9c0-1.7-1.3-3-3-3z"/>
                                <path d="M18 12c0 3.3-2.7 6-6 6s-6-2.7-6-6"/>
                            </svg>
                            {navigator.userAgent.includes('Mac') ? 'Unlock with Touch ID' : 'Unlock with Windows Hello'}
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
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                {showPassword ? (
                                    <>
                                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                    </>
                                ) : (
                                    <>
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                        <circle cx="12" cy="12" r="3" />
                                    </>
                                )}
                            </svg>
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
                                <svg
                                    className="spinner"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    <circle className="spinner-circle" cx="12" cy="12" r="10" />
                                </svg>
                            ) : (
                                <>
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        className="unlock-icon"
                                    >
                                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                                    </svg>
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
import { useState, useEffect } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Database } from '../../types/database';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { ImportService, ImportResult } from '../../services/ImportService';
import { LockAuthIcon, BiometricAuthIcon, ShowPasswordIcon, HidePasswordIcon, UnlockAuthIcon } from '../../icons/auth/AuthIcons';
import { KeyActionIcon, UsbKeyIcon } from '../../icons/actions/ActionIcons';
import { SpinnerIcon } from '../../icons/status/StatusIcons';
import { userSettingsService } from '../../services/UserSettingsService';
import {
    HardwareKeySelection,
    buildCredentials as buildVaultCredentials,
    hardwareKeyErrorMessage,
    hardwareKeyLabel,
    keyFileName,
    rememberKeyMaterial,
    rememberedKeyMaterial
} from '../../services/VaultCredentials';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';

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
    browserPasswords?: ImportResult;
    setBrowserPasswords?: (passwords: ImportResult | undefined) => void;
}

// What this platform calls its biometric check, in the user's words
const BIOMETRIC_METHOD_NAME = navigator.userAgent.includes('Mac')
    ? 'Touch ID'
    : navigator.userAgent.includes('Windows') ? 'Windows Hello' : 'Biometrics';

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
    // Why the option is missing on a machine whose sensor works (an unsigned
    // macOS build); the user should be told, since nothing else explains it
    const [biometricsUnavailableReason, setBiometricsUnavailableReason] = useState<string | null>(null);
    // Whether an unlock attempt could release a password right now. False for
    // a session-scoped vault after a restart, until the password unlock below
    // re-arms it
    const [biometricsArmed, setBiometricsArmed] = useState(true);
    const [showPasswordInput, setShowPasswordInput] = useState(!initialBiometricsEnabled);
    const [keyFile, setKeyFile] = useState<{ path: string; name: string } | null>(null);
    const [hardwareKey, setHardwareKey] = useState<HardwareKeySelection | null>(null);
    const [hardwareKeyPresent, setHardwareKeyPresent] = useState(false);

    // The hardware key option only shows when one is plugged in; poll so it
    // appears when the key is inserted while sitting on this screen. The
    // probe is pure USB enumeration, it never opens the device
    useEffect(() => {
        if (!window.electron?.isHardwareKeyPresent) return;
        let cancelled = false;
        const probe = async () => {
            const present = await window.electron!.isHardwareKeyPresent().catch(() => false);
            if (!cancelled) setHardwareKeyPresent(present);
        };
        probe();
        const timer = setInterval(probe, 2500);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        const remembered = rememberedKeyMaterial(databasePath);
        setKeyFile(remembered.keyFile);
        setHardwareKey(remembered.hardwareKey);
    }, [databasePath]);

    const buildCredentials = (passwordStr: string): Promise<kdbxweb.Credentials> =>
        buildVaultCredentials(passwordStr, keyFile, hardwareKey);

    const rememberKeyFile = (dbPath: string | null | undefined) => rememberKeyMaterial(dbPath, keyFile, hardwareKey);

    const handleSelectKeyFile = async () => {
        const result = await window.electron?.selectKeyFile();
        if (result?.filePath) {
            setKeyFile({ path: result.filePath, name: keyFileName(result.filePath) });
            setError('');
        }
    };

    const handleSelectHardwareKey = async () => {
        if (!window.electron) return;
        const result = await window.electron.listHardwareKeys();
        if (result.blocked) {
            setError(hardwareKeyErrorMessage('HARDWARE_KEY_ACCESS_DENIED'));
            return;
        }
        const key = result.keys[0];
        if (!key) {
            setError('No hardware key detected. Plug in your YubiKey and try again.');
            return;
        }
        // Slot 2 is the challenge-response convention (slot 1 ships with the
        // factory OTP credential)
        const slot: 1 | 2 = !key.slot2Configured && key.slot1Configured ? 1 : 2;
        setHardwareKey({ serial: key.serial, slot, label: hardwareKeyLabel(key.serial) });
        setError('');
    };

    const unlockError = (err: unknown): string => {
        if (err instanceof Error && err.message === 'KEYFILE_READ_FAILED') {
            return `Failed to read key file ${keyFile?.path}; select it again to restore access`;
        }
        // The main process said why the vault could not be read (an online-only
        // file that did not download); the password had nothing to do with it
        if (err instanceof Error && err.message.startsWith('FILE_READ_FAILED:')) {
            return err.message.slice('FILE_READ_FAILED:'.length);
        }
        if (err instanceof Error && err.message.startsWith('HARDWARE_KEY')) {
            return hardwareKeyErrorMessage(err.message);
        }
        // Refused by the main process before any key derivation ran: the
        // header asks for more than the app will do. Not a wrong password,
        // and retyping it will not help, so say what actually happened
        if (err instanceof Error && (/Unreasonable Argon2 parameters/.test(err.message) || err.message === 'KDF_WORK_EXCEEDED')) {
            return 'This database asks for more key derivation work than Vigil will do; it may be corrupted or crafted to hang the app';
        }
        if (err instanceof Error && /window that asked for this unlock|took too long and was stopped/.test(err.message)) {
            return 'Key derivation was stopped before it finished';
        }
        if (hardwareKey) {
            return 'Invalid password or wrong hardware key response';
        }
        return keyFile
            ? 'Invalid password or key file'
            : 'Invalid password or corrupted database file';
    };

    useEffect(() => {
        const checkBiometrics = async () => {
            if (!window.electron) return;
            const info = await window.electron.getBiometricsInfo();
            setIsBiometricsAvailable(info.available);
            setBiometricsUnavailableReason(info.unavailableReason ?? null);
        };
        checkBiometrics();
    }, []);

    useEffect(() => {
        if (!window.electron || !databasePath || !isBiometricsEnabled) {
            setBiometricsArmed(true);
            return;
        }
        let cancelled = false;
        window.electron.hasBiometricsEnabled(databasePath).then(result => {
            if (cancelled) return;
            // false only for a session-scoped vault awaiting its re-arm (or a
            // persistent blob frozen by the restart-lock setting): the
            // password field is what unlocks now, so lead with it
            setBiometricsArmed(result.armed !== false);
            if (result.armed === false) setShowPasswordInput(true);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [databasePath, isBiometricsEnabled]);

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
            // Check passwords, unless the user opted out of the online sweep
            (async () => {
                if (userSettingsService.getCheckPasswordBreaches() && hasCheckedPasswordEntries && !allPasswordEntriesCached) {
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
                const hasApikey = await HaveIBeenPwnedService.hasApiKey();
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
                // A dismissed prompt or an unrecognised finger leaves the
                // stored credential intact, so only tear the setup down when
                // the credential itself can no longer be opened
                if (!biometricResult.retry) {
                    await window.electron.disableBiometrics(databasePath);
                    setIsBiometricsEnabled(false);
                }
                setShowPasswordInput(true);
                (window as any).showToast?.({
                    message: biometricResult.error || 'Switched to password authentication',
                    type: 'info'
                });
                throw new Error('Failed to get biometric password');
            }

            const result = await window.electron.readFile(databasePath);
            if (!result.success || !result.data) {
                throw new Error(`FILE_READ_FAILED:${result.error || 'Failed to read file'}`);
            }

            const credentials = await buildCredentials(biometricResult.password);

            const bytes = new Uint8Array(result.data.buffer).buffer;
            KeepassDatabaseService.assertKdfOpenable(bytes);
            const db = await kdbxweb.Kdbx.load(bytes, credentials);

            const database = KeepassDatabaseService.convertKdbxToDatabase(db);
            KeepassDatabaseService.setPath(databasePath, new Uint8Array(result.data));
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
                        throw new Error(`FILE_READ_FAILED:${result.error || 'Failed to read file'}`);
                    }
                    fileBuffer = result.data.buffer;
                } else {
                    fileBuffer = await selectedFile!.arrayBuffer();
                }

                const bytes = new Uint8Array(fileBuffer).buffer;
                KeepassDatabaseService.assertKdfOpenable(bytes);
                await kdbxweb.Kdbx.load(bytes, credentials);

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
                // Always the typed password. Biometric unlock is a separate,
                // explicitly invoked path (handleBiometricUnlock); consulting
                // the keychain here meant entering a password still raised a
                // biometric prompt
                credentials = await buildCredentials(password);

                const result = await window.electron.readFile(databasePath);
                if (!result.success || !result.data) {
                    throw new Error(`FILE_READ_FAILED:${result.error || 'Failed to read file'}`);
                }
                fileBuffer = result.data.buffer;
                await window.electron.saveLastDatabasePath(databasePath);
                KeepassDatabaseService.setPath(databasePath, new Uint8Array(result.data));
            } else {
                fileBuffer = await selectedFile.arrayBuffer();
                credentials = await buildCredentials(password);
            }

            // Refused here for AES-KDF headers, and by the main process for
            // Argon2 ones: a file asking for more work than the app will do
            // must fail this unlock, not hang the renderer
            const bytes = new Uint8Array(fileBuffer).buffer;
            KeepassDatabaseService.assertKdfOpenable(bytes);
            const db = await kdbxweb.Kdbx.load(bytes, credentials);

            const database = KeepassDatabaseService.convertKdbxToDatabase(db);
            rememberKeyFile(databasePath);
            onDatabaseOpen(database, db);

            // A session-scoped biometric setup (require password after
            // restart) is re-armed by exactly this: the typed master
            // password. The Hello prompt that follows signs the key the
            // password is sealed under for the session (as KeePassXC does);
            // declining it just leaves the vault unarmed until next time
            if (isBiometricsEnabled && !biometricsArmed && databasePath && window.electron) {
                void window.electron.enableBiometrics(databasePath, password)
                    .then(result => {
                        if (result.success) {
                            setBiometricsArmed(true);
                            return;
                        }
                        // Swallowing this made a vault that failed to arm look
                        // identical to one that armed fine, until the next
                        // biometric attempt failed with no reason given
                        console.error('Failed to arm biometric unlock:', result.error);
                        (window as any).showToast?.({
                            message: result.error || 'Could not turn biometric unlock back on',
                            type: 'error',
                            duration: 5000
                        });
                    })
                    .catch(err => console.error('Failed to arm biometric unlock:', err));
            }

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
            // kdbxweb creates 4.0, which has nowhere to put tags, per-entry
            // quality-check flags or previousParentGroup (what restoring out of
            // the recycle bin reads to find the original group). KeePassXC has
            // written 4.1 since 2.7; readers older than KeePass 2.48 / KeePassXC
            // 2.7 ignore the extra elements rather than refusing the file
            db.header.versionMinor = 1;
            // kdbxweb defaults to Argon2d with 1 MiB / 2 iterations, far too weak
            KeepassDatabaseService.setKdf(db, KeepassDatabaseService.RECOMMENDED_KDF);

            // Seed the new database with imported passwords if any
            if (browserPasswords && browserPasswords.entries.length > 0) {
                await ImportService.writeEntries(browserPasswords, db);
                setBrowserPasswords?.(undefined);
            }

            const arrayBuffer = await db.save();
            // Creating a database over a file that already exists is the most
            // destructive thing the app does, so it goes through the same
            // backup the ordinary save path uses
            const result = await window.electron?.saveFile(
                new Uint8Array(arrayBuffer),
                userSettingsService.getBackupOptions()
            );

            if (!result?.success) {
                throw new Error(result?.error || 'Failed to save database');
            }

            if (result.filePath) {
                await window.electron?.saveLastDatabasePath(result.filePath);
                KeepassDatabaseService.setPath(result.filePath, new Uint8Array(arrayBuffer));
                rememberKeyFile(result.filePath);
            }

            onDatabaseOpen(KeepassDatabaseService.convertKdbxToDatabase(db), db);
        } catch (err) {
            console.error('Failed to create database:', err);
            if (err instanceof Error && err.message.startsWith('HARDWARE_KEY')) {
                setError(hardwareKeyErrorMessage(err.message));
            } else {
                setError(err instanceof Error ? err.message : 'Failed to create database');
            }
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
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
                        title="Clear selection" aria-label="Clear selection"
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
                        aria-label="Database name"
                        className="text-input"
                        value={databaseName}
                        onChange={(e) => setDatabaseName(e.target.value)}
                        onKeyDown={handleKeyDown}
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
                            title="Remove key file" aria-label="Remove key file"
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

            {(selectedFile || isCreatingNew) && window.electron && (
                hardwareKey ? (
                    <div className="key-file-chip" title={`Challenge-response on slot ${hardwareKey.slot}`}>
                        <UsbKeyIcon className="key-file-icon" />
                        <span className="key-file-name">{hardwareKey.label}</span>
                        <div className="slot-toggle" role="group" aria-label="Hardware key slot">
                            <button
                                className={hardwareKey.slot === 1 ? 'active' : ''}
                                aria-pressed={hardwareKey.slot === 1}
                                onClick={() => setHardwareKey({ ...hardwareKey, slot: 1 })}
                                title="Use slot 1" aria-label="Use slot 1"
                            >
                                1
                            </button>
                            <button
                                className={hardwareKey.slot === 2 ? 'active' : ''}
                                aria-pressed={hardwareKey.slot === 2}
                                onClick={() => setHardwareKey({ ...hardwareKey, slot: 2 })}
                                title="Use slot 2" aria-label="Use slot 2"
                            >
                                2
                            </button>
                        </div>
                        <button
                            className="clear-file"
                            onClick={() => {
                                setHardwareKey(null);
                                setError('');
                            }}
                            title="Remove hardware key" aria-label="Remove hardware key"
                        >
                            ×
                        </button>
                    </div>
                ) : hardwareKeyPresent ? (
                    <button className="add-key-file" onClick={handleSelectHardwareKey} type="button">
                        <UsbKeyIcon className="key-file-icon" />
                        Hardware key (optional)
                    </button>
                ) : null
            )}

            {selectedFile && !isCreatingNew && isBiometricsAvailable && (
                <>
                    <div className="auth-toggle" role="group" aria-label="Unlock method">
                        <button
                            className={`auth-option ${!isBiometricsEnabled || showPasswordInput ? 'active' : ''}`}
                            aria-pressed={!isBiometricsEnabled || showPasswordInput}
                            onClick={() => setShowPasswordInput(true)}
                        >
                            <LockAuthIcon className="auth-icon" />
                            Password
                        </button>
                        <button
                            className={`auth-option ${isBiometricsEnabled && !showPasswordInput ? 'active' : ''}`}
                            aria-pressed={isBiometricsEnabled && !showPasswordInput}
                            onClick={() => {
                                if (!isBiometricsEnabled) {
                                    setShowPasswordInput(true);
                                    handleBiometricsToggle();
                                    return;
                                }
                                // Enrolled but not armed: this run of Vigil holds
                                // no sealed copy for the biometric check to
                                // release, so an attempt could only fail and
                                // re-show the same notice. The typed master
                                // password is exactly what unlocks and arms it,
                                // so spend it rather than sending the user
                                // through a prompt that cannot succeed
                                if (!biometricsArmed) {
                                    setShowPasswordInput(true);
                                    if (password) void handleUnlock();
                                    else passwordInputRef.current?.focus();
                                    return;
                                }
                                setShowPasswordInput(false);
                                handleBiometricUnlock();
                            }}
                        >
                            <BiometricAuthIcon className="auth-icon" />
                            {BIOMETRIC_METHOD_NAME}
                        </button>
                    </div>

                    {isBiometricsEnabled && !biometricsArmed && (
                        <p className="biometric-weak-notice">
                            {BIOMETRIC_METHOD_NAME} needs your master password once each time Vigil
                            starts.
                        </p>
                    )}

                    {isBiometricsEnabled && !showPasswordInput && (
                        <button
                            className="biometric-unlock-button"
                            onClick={handleBiometricUnlock}
                            disabled={isLoading}
                        >
                            <BiometricAuthIcon className="biometric-icon" />
                            Unlock with {BIOMETRIC_METHOD_NAME}
                        </button>
                    )}

                    {isBiometricsEnabled && (
                        <button
                            className="biometric-disable-button"
                            onClick={handleBiometricsToggle}
                            disabled={isLoading}
                        >
                            Forget {BIOMETRIC_METHOD_NAME} for this database
                        </button>
                    )}
                </>
            )}

            {selectedFile && !isCreatingNew && !isBiometricsAvailable && biometricsUnavailableReason && (
                <p className="biometric-weak-notice" title={biometricsUnavailableReason}>
                    Biometric unlock is off in this build
                </p>
            )}

            {(!isBiometricsAvailable || showPasswordInput || !isBiometricsEnabled || isCreatingNew) && (
                <>
                    <div className="password-input-container">
                        <input
                            type={showPassword ? 'text' : 'password'}
                            placeholder={isCreatingNew ? "Create password" : "Enter password"}
                            aria-label={isCreatingNew ? "Create password" : "Enter password"}
                            className="password-input"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            ref={passwordInputRef}
                            onKeyDown={handleKeyDown}
                        />
                        <button
                            className="toggle-password"
                            onClick={() => setShowPassword(!showPassword)}
                            type="button"
                            title={showPassword ? 'Hide password' : 'Show password'} aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                            {showPassword ? <HidePasswordIcon /> : <ShowPasswordIcon />}
                        </button>
                    </div>

                    {isCreatingNew && (
                        <div className="password-input-container">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                placeholder="Confirm password"
                                aria-label="Confirm password"
                                className="password-input"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                onKeyDown={handleKeyDown}
                            />
                        </div>
                    )}

                    {error && <div className="error-message" role="alert">{error}</div>}

                    <div className="form-buttons">
                        {isCreatingNew && (
                            <button
                                className="auth-cancel-button"
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
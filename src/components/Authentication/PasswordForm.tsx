import { useState, useEffect, useRef } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Database } from '../../types/database';
import type { QuickUnlockMethod } from '../../types/electron';
import { QUICK_UNLOCK_NAMES, PIN_PATTERN, PIN_RULE } from '../../services/QuickUnlockMethods';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { ImportService, ImportResult } from '../../services/ImportService';
import { LockAuthIcon, BiometricAuthIcon, PinAuthIcon, ShowPasswordIcon, HidePasswordIcon, UnlockAuthIcon } from '../../icons/auth/AuthIcons';
import { ChevronActionIcon, KeyActionIcon, UsbKeyIcon } from '../../icons/actions/ActionIcons';
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

const QuickUnlockIcon = ({ method, className }: { method: QuickUnlockMethod | null; className: string }) =>
    method === 'pin' ? <PinAuthIcon className={className} /> : <BiometricAuthIcon className={className} />;

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
    const [methods, setMethods] = useState<QuickUnlockMethod[]>([]);
    const [vaultMethod, setVaultMethod] = useState<QuickUnlockMethod | null>(null);
    const [chosenMethod, setChosenMethod] = useState<QuickUnlockMethod | null>(null);
    const [methodMenuOpen, setMethodMenuOpen] = useState(false);
    const [pin, setPin] = useState('');
    const [pinSetup, setPinSetup] = useState(false);
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const pinInputRef = useRef<HTMLInputElement>(null);
    const methodMenuRef = useRef<HTMLDivElement>(null);
    const methodMenuButtonRef = useRef<HTMLButtonElement>(null);
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
            setMethods(info.methods ?? []);
        };
        checkBiometrics();
    }, []);

    useEffect(() => {
        if (!window.electron || !databasePath || !isBiometricsEnabled) {
            setBiometricsArmed(true);
            setVaultMethod(null);
            return;
        }
        let cancelled = false;
        window.electron.hasBiometricsEnabled(databasePath).then(result => {
            if (cancelled) return;
            setVaultMethod(result.method ?? null);
            // false only for a session-scoped vault awaiting its re-arm (or a
            // persistent blob frozen by the restart-lock setting): the
            // password field is what unlocks now, so lead with it
            setBiometricsArmed(result.armed !== false);
            if (result.armed === false) setShowPasswordInput(true);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [databasePath, isBiometricsEnabled]);

    useEffect(() => {
        setChosenMethod(null);
        setPinSetup(false);
        setPin('');
        setNewPin('');
        setConfirmPin('');
        setMethodMenuOpen(false);
    }, [databasePath]);

    useEffect(() => {
        if (!methodMenuOpen) return;
        const closeOnOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (methodMenuRef.current?.contains(target) || methodMenuButtonRef.current?.contains(target)) return;
            setMethodMenuOpen(false);
        };
        document.addEventListener('mousedown', closeOnOutside);
        methodMenuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
        return () => document.removeEventListener('mousedown', closeOnOutside);
    }, [methodMenuOpen]);

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

    const usingEnrolled = isBiometricsEnabled && chosenMethod === null;
    const activeMethod: QuickUnlockMethod | null = usingEnrolled
        ? vaultMethod ?? methods[0] ?? null
        : chosenMethod ?? methods[0] ?? null;
    const methodName = activeMethod ? QUICK_UNLOCK_NAMES[activeMethod] : 'Biometrics';
    const quickUnlockActive = (usingEnrolled && !showPasswordInput) || pinSetup;
    const showPinUnlock = usingEnrolled && !showPasswordInput && vaultMethod === 'pin';

    useEffect(() => {
        if (showPinUnlock) pinInputRef.current?.focus();
    }, [showPinUnlock]);

    const resetPinSetup = () => {
        setPinSetup(false);
        setNewPin('');
        setConfirmPin('');
    };

    const handleBiometricUnlock = async () => {
        if (!selectedFile || !databasePath || !window.electron || !isBiometricsEnabled) return;
        const usingPin = vaultMethod === 'pin';
        if (usingPin && !pin) {
            setError('Enter your PIN');
            pinInputRef.current?.focus();
            return;
        }

        setIsLoading(true);
        setError('');

        try {
            const biometricResult = await window.electron.getBiometricPassword(databasePath, usingPin ? pin : undefined);
            if (usingPin) setPin('');
            if (!biometricResult.success || !biometricResult.password) {
                if (usingPin && biometricResult.retry) {
                    setError(biometricResult.error || 'Incorrect PIN');
                    pinInputRef.current?.focus();
                    return;
                }
                // A dismissed prompt or an unrecognised finger leaves the
                // stored credential intact, so only tear the setup down when
                // the credential itself can no longer be opened
                if (!biometricResult.retry) {
                    await window.electron.disableBiometrics(databasePath);
                    setIsBiometricsEnabled(false);
                    setVaultMethod(null);
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

    const handleForgetQuickUnlock = async () => {
        if (!window.electron || !databasePath) return;
        const name = QUICK_UNLOCK_NAMES[vaultMethod ?? activeMethod ?? 'touch-id'];
        const result = await window.electron.disableBiometrics(databasePath);
        if (result.success) {
            setIsBiometricsEnabled(false);
            setVaultMethod(null);
            setChosenMethod(null);
            resetPinSetup();
            setShowPasswordInput(true);
            (window as any).showToast?.({
                message: `${name} turned off for this database`,
                type: 'success'
            });
        } else {
            (window as any).showToast?.({
                message: `Failed to turn off ${name}`,
                type: 'error'
            });
        }
    };

    const turnOnQuickUnlock = async (method: QuickUnlockMethod, newPinValue?: string) => {
        if (!window.electron || !databasePath) return;
        const name = QUICK_UNLOCK_NAMES[method];
        if (!password) {
            setError(`Enter your database password to turn on ${name}`);
            passwordInputRef.current?.focus();
            return;
        }

        try {
            const credentials = await buildCredentials(password);
            const read = await window.electron.readFile(databasePath);
            if (!read.success || !read.data) {
                throw new Error(`FILE_READ_FAILED:${read.error || 'Failed to read file'}`);
            }
            const bytes = new Uint8Array(read.data.buffer).buffer;
            KeepassDatabaseService.assertKdfOpenable(bytes);
            await kdbxweb.Kdbx.load(bytes, credentials);
        } catch {
            setError('Invalid database password');
            return;
        }

        const result = await window.electron.enableBiometrics(databasePath, password, { method, pin: newPinValue });
        if (!result.success) {
            (window as any).showToast?.({
                message: result.error || `Failed to turn on ${name}`,
                type: 'error'
            });
            return;
        }
        setIsBiometricsEnabled(true);
        setVaultMethod(method);
        setChosenMethod(null);
        resetPinSetup();
        setShowPasswordInput(false);
        setPassword('');
        (window as any).showToast?.({
            message: `${name} turned on`,
            type: 'success'
        });
        handleUnlock();
    };

    const startEnrollment = (method: QuickUnlockMethod) => {
        setShowPasswordInput(true);
        setError('');
        if (method === 'pin') {
            setPinSetup(true);
            return;
        }
        resetPinSetup();
        void turnOnQuickUnlock(method);
    };

    const submitPinSetup = () => {
        if (!PIN_PATTERN.test(newPin)) {
            setError(PIN_RULE);
            return;
        }
        if (newPin !== confirmPin) {
            setError('The PINs do not match');
            return;
        }
        void turnOnQuickUnlock('pin', newPin);
    };

    const chooseMethod = (method: QuickUnlockMethod) => {
        setMethodMenuOpen(false);
        methodMenuButtonRef.current?.focus();
        if (isBiometricsEnabled && method === vaultMethod) {
            setChosenMethod(null);
            resetPinSetup();
            setError('');
            return;
        }
        setChosenMethod(method);
        startEnrollment(method);
    };

    const handleMethodMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            setMethodMenuOpen(false);
            methodMenuButtonRef.current?.focus();
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            items[(index + 1) % items.length]?.focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            items[(index - 1 + items.length) % items.length]?.focus();
        }
    };

    const handleMethodClick = () => {
        if (!activeMethod) return;
        if (!usingEnrolled) {
            startEnrollment(activeMethod);
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
        if (vaultMethod === 'pin') {
            pinInputRef.current?.focus();
            return;
        }
        handleBiometricUnlock();
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
            } else if (pinSetup) {
                submitPinSetup();
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
                    <div className="auth-toggle-wrapper">
                        <div className="auth-toggle" role="group" aria-label="Unlock method">
                            <button
                                className={`auth-option ${!quickUnlockActive ? 'active' : ''}`}
                                aria-pressed={!quickUnlockActive}
                                onClick={() => {
                                    setShowPasswordInput(true);
                                    setChosenMethod(null);
                                    resetPinSetup();
                                    setError('');
                                }}
                            >
                                <LockAuthIcon className="auth-icon" />
                                Password
                            </button>
                            <button
                                className={`auth-option ${quickUnlockActive ? 'active' : ''}`}
                                aria-pressed={quickUnlockActive}
                                onClick={handleMethodClick}
                            >
                                <QuickUnlockIcon method={activeMethod} className="auth-icon" />
                                {methodName}
                            </button>
                            {methods.length > 1 && (
                                <button
                                    ref={methodMenuButtonRef}
                                    className={`auth-method-menu-button ${methodMenuOpen ? 'open' : ''}`}
                                    aria-label="Choose unlock method"
                                    title="Choose unlock method"
                                    aria-haspopup="menu"
                                    aria-expanded={methodMenuOpen}
                                    onClick={() => setMethodMenuOpen(open => !open)}
                                    disabled={isLoading}
                                >
                                    <ChevronActionIcon className="auth-method-chevron" />
                                </button>
                            )}
                        </div>

                        {methodMenuOpen && (
                            <div
                                ref={methodMenuRef}
                                className="auth-method-menu"
                                role="menu"
                                aria-label="Unlock methods"
                                onKeyDown={handleMethodMenuKeyDown}
                            >
                                {methods.map(method => (
                                    <button
                                        key={method}
                                        role="menuitemradio"
                                        aria-checked={method === activeMethod}
                                        className={`auth-method-item ${method === activeMethod ? 'selected' : ''}`}
                                        onClick={() => chooseMethod(method)}
                                    >
                                        <QuickUnlockIcon method={method} className="auth-icon" />
                                        {QUICK_UNLOCK_NAMES[method]}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {usingEnrolled && !biometricsArmed && (
                        <p className="biometric-weak-notice">
                            {methodName} needs your master password once each time Vigil
                            starts.
                        </p>
                    )}

                    {showPinUnlock && (
                        <>
                            <div className="password-input-container">
                                <input
                                    ref={pinInputRef}
                                    type="password"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    placeholder="Enter PIN"
                                    aria-label="PIN"
                                    className="password-input"
                                    value={pin}
                                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !isLoading) handleBiometricUnlock();
                                    }}
                                />
                            </div>
                            {error && <div className="error-message" role="alert">{error}</div>}
                        </>
                    )}

                    {usingEnrolled && !showPasswordInput && (
                        <button
                            className="biometric-unlock-button"
                            onClick={handleBiometricUnlock}
                            disabled={isLoading || (showPinUnlock && !pin)}
                        >
                            <QuickUnlockIcon method={activeMethod} className="biometric-icon" />
                            Unlock with {methodName}
                        </button>
                    )}

                    {isBiometricsEnabled && !pinSetup && (
                        <button
                            className="biometric-disable-button"
                            onClick={handleForgetQuickUnlock}
                            disabled={isLoading}
                        >
                            Forget {QUICK_UNLOCK_NAMES[vaultMethod ?? activeMethod ?? 'touch-id']} for this database
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

                    {pinSetup && !isCreatingNew && (
                        <>
                            <div className="password-input-container">
                                <input
                                    type="password"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    placeholder="Choose a PIN (6+ digits)"
                                    aria-label="Choose a PIN"
                                    className="password-input"
                                    value={newPin}
                                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                                    onKeyDown={handleKeyDown}
                                />
                            </div>
                            <div className="password-input-container">
                                <input
                                    type="password"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    placeholder="Confirm PIN"
                                    aria-label="Confirm PIN"
                                    className="password-input"
                                    value={confirmPin}
                                    onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                                    onKeyDown={handleKeyDown}
                                />
                            </div>
                        </>
                    )}

                    {error && !showPinUnlock && <div className="error-message" role="alert">{error}</div>}

                    {pinSetup && !isCreatingNew ? (
                        <div className="form-buttons">
                            <button
                                className="auth-cancel-button"
                                onClick={() => {
                                    setChosenMethod(null);
                                    resetPinSetup();
                                    setError('');
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                className={`unlock-button ${isLoading ? 'loading' : ''}`}
                                onClick={submitPinSetup}
                                disabled={isLoading}
                            >
                                <PinAuthIcon className="unlock-icon" />
                                Turn on PIN
                            </button>
                        </div>
                    ) : (
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
                    )}
                </>
            )}
        </div>
    );
};
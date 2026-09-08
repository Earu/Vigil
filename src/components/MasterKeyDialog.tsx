import { useEffect, useState } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Modal } from './Modal';
import { KeyActionIcon, UsbKeyIcon } from '../icons/actions/ActionIcons';
import { KeepassDatabaseService, PendingCredentialChange } from '../services/KeepassDatabaseService';
import { changeMasterPassword } from '../services/MasterPasswordChange';
import { offerBackupPurge } from '../services/BackupPurge';
import {
    HardwareKeySelection,
    hardwareKeyChallengeCallback,
    hardwareKeyErrorMessage,
    hardwareKeyLabel,
    keyFileName,
    rememberKeyMaterial,
    rememberedKeyMaterial
} from '../services/VaultCredentials';
import './BrowserPairingDialog.css';
import './Authentication/AuthenticationView.css';
import './MasterKeyDialog.css';

interface MasterKeyDialogProps {
    kdbxDb: kdbxweb.Kdbx;
    // Saves the vault with the credential change riding along, applied once
    // the file on disk has been read and merged. True when it landed
    onSave: (rekeyTo: PendingCredentialChange) => Promise<boolean>;
    onClose: () => void;
}

// 'keep' is the part of the key the vault already has and this dialog has no
// reason to touch: the credentials hold it, so leaving it out of the change
// keeps it, and the key file's bytes never have to be read again
type KeyFileChoice =
    | { kind: 'none' }
    | { kind: 'keep'; name?: string }
    | { kind: 'file'; path: string; name: string };

type HardwareChoice =
    | { kind: 'none' }
    | { kind: 'keep' }
    | { kind: 'key'; serial: number | null; slot: 1 | 2; label: string };

// The whole master key in one place, the way the unlock screen asks for it:
// password, key file and hardware key together. Anything the vault already
// has starts filled in, so a change to one part leaves the others alone.
export const MasterKeyDialog = ({ kdbxDb, onSave, onClose }: MasterKeyDialogProps) => {
    const dbPath = KeepassDatabaseService.getPath() ?? null;
    const hasKeyFile = !!kdbxDb.credentials.keyFileHash;
    const usesHardwareKey = KeepassDatabaseService.usesHardwareKey(kdbxDb);

    const [currentPw, setCurrentPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [confirmPw, setConfirmPw] = useState('');
    const [keyFile, setKeyFile] = useState<KeyFileChoice>(() => {
        if (!hasKeyFile) return { kind: 'none' };
        return { kind: 'keep', name: rememberedKeyMaterial(dbPath).keyFile?.name };
    });
    const [hardwareKey, setHardwareKey] = useState<HardwareChoice>(() => {
        const remembered = rememberedKeyMaterial(dbPath).hardwareKey;
        if (remembered) return { kind: 'key', ...remembered };
        return usesHardwareKey ? { kind: 'keep' } : { kind: 'none' };
    });
    const [hardwareKeyPresent, setHardwareKeyPresent] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Only offered while a key is plugged in; polled so it appears when one
    // is inserted with the dialog open. Pure USB enumeration, the device is
    // never opened
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

    const selectKeyFile = async () => {
        const result = await window.electron?.selectKeyFile();
        if (!result?.filePath) return;
        setKeyFile({ kind: 'file', path: result.filePath, name: keyFileName(result.filePath) });
        setError(null);
    };

    const generateKeyFile = async () => {
        const bytes = await kdbxweb.Credentials.createRandomKeyFile(2);
        const saved = await window.electron?.saveKeyFile(`${kdbxDb.meta.name || 'database'}.keyx`, bytes);
        if (!saved?.success || !saved.filePath) return;
        setKeyFile({ kind: 'file', path: saved.filePath, name: keyFileName(saved.filePath) });
        setError(null);
    };

    const selectHardwareKey = async () => {
        if (!window.electron) return;
        const result = await window.electron.listHardwareKeys();
        if (result.blocked) {
            setError(hardwareKeyErrorMessage('HARDWARE_KEY_ACCESS_DENIED'));
            return;
        }
        const key = result.keys[0];
        if (!key) {
            setError(hardwareKeyErrorMessage('HARDWARE_KEY_NOT_FOUND'));
            return;
        }
        // Slot 2 is the challenge-response convention (slot 1 ships with the
        // factory OTP credential)
        const slot: 1 | 2 = !key.slot2Configured && key.slot1Configured ? 1 : 2;
        setHardwareKey({ kind: 'key', serial: key.serial, slot, label: hardwareKeyLabel(key.serial) });
        setError(null);
    };

    // Only the parts that change go in: an absent field is left as it is,
    // and null is what removes one
    const credentialChange = async (): Promise<PendingCredentialChange> => {
        const change: PendingCredentialChange = {};
        if (keyFile.kind === 'file') {
            const read = await window.electron?.readFile(keyFile.path);
            if (!read?.success || !read.data) throw new Error('KEYFILE_READ_FAILED');
            change.keyFile = new Uint8Array(read.data).buffer;
        } else if (keyFile.kind === 'none' && hasKeyFile) {
            change.keyFile = null;
        }
        if (hardwareKey.kind === 'key') {
            change.challengeResponse = hardwareKeyChallengeCallback(hardwareKey.serial, hardwareKey.slot);
        } else if (hardwareKey.kind === 'none' && usesHardwareKey) {
            change.challengeResponse = null;
        }
        return change;
    };

    // What the next unlock has to offer. 'keep' leaves whatever is remembered
    // where it is, since nothing about that part of the key changed
    const rememberChoices = () => {
        const remembered = rememberedKeyMaterial(dbPath);
        const file = keyFile.kind === 'file'
            ? { path: keyFile.path, name: keyFile.name }
            : keyFile.kind === 'keep' ? remembered.keyFile : null;
        const hw: HardwareKeySelection | null = hardwareKey.kind === 'key'
            ? { serial: hardwareKey.serial, slot: hardwareKey.slot, label: hardwareKey.label }
            : hardwareKey.kind === 'keep' ? remembered.hardwareKey : null;
        rememberKeyMaterial(dbPath, file, hw);
    };

    const submit = async () => {
        setError(null);
        if (!newPw) {
            setError('The new password cannot be empty');
            return;
        }
        if (newPw !== confirmPw) {
            setError('The new passwords do not match');
            return;
        }
        if (!(await KeepassDatabaseService.verifyMasterPassword(kdbxDb, currentPw))) {
            setError('The current password is incorrect');
            return;
        }

        setBusy(true);
        let change: PendingCredentialChange;
        try {
            change = await credentialChange();
        } catch {
            setBusy(false);
            setError(keyFile.kind === 'file'
                ? `Failed to read key file ${keyFile.path}; select it again`
                : 'The key file could not be read');
            return;
        }

        const outcome = await changeMasterPassword(newPw, (rekeyTo) => onSave({ ...rekeyTo, ...change }));
        setBusy(false);
        if (!outcome.saved) {
            // The save path has already said what failed; the vault keeps the
            // key it had, so the dialog stays open on the same values
            setError('The master key was not changed');
            return;
        }

        rememberChoices();
        (window as any).showToast?.(outcome.biometrics === 'off'
            ? {
                message: `Master key changed. Biometric unlock was turned off: ${outcome.reason}. Turn it on again from the unlock screen`,
                type: 'error',
                duration: 8000
            }
            : { message: 'Master key changed', type: 'success', duration: 3000 });
        onClose();
        await offerBackupPurge();
    };

    const keyFileLabel = keyFile.kind === 'keep'
        ? keyFile.name ?? 'Current key file'
        : keyFile.kind === 'file' ? keyFile.name : '';

    return (
        <Modal
            overlayClassName="pairing-overlay"
            className="pairing-dialog master-key-dialog"
            labelledBy="master-key-title"
            onClose={busy ? undefined : onClose}
        >
            <h3 id="master-key-title">Change the master key</h3>
            <p>
                Close this vault on your other devices first and let the file finish
                syncing. A device that still has it open cannot read the re-encrypted
                file and will have to be given the new key.
            </p>
            <label className="master-key-field">
                <span>Current password</span>
                <input
                    type="password"
                    autoFocus
                    value={currentPw}
                    onChange={(e) => { setCurrentPw(e.target.value); setError(null); }}
                />
            </label>
            <label className="master-key-field">
                <span>New password</span>
                <input
                    type="password"
                    value={newPw}
                    onChange={(e) => { setNewPw(e.target.value); setError(null); }}
                />
            </label>
            <label className="master-key-field">
                <span>Confirm new password</span>
                <input
                    type="password"
                    value={confirmPw}
                    onChange={(e) => { setConfirmPw(e.target.value); setError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
                />
            </label>
            {window.electron && (keyFile.kind === 'none' ? (
                <div className="master-key-add-row">
                    <button className="add-key-file" onClick={selectKeyFile} type="button">
                        <KeyActionIcon className="key-file-icon" />
                        Key file (optional)
                    </button>
                    <button className="add-key-file" onClick={generateKeyFile} type="button">
                        Generate
                    </button>
                </div>
            ) : (
                <div className="key-file-chip" title={keyFile.kind === 'file' ? keyFile.path : undefined}>
                    <KeyActionIcon className="key-file-icon" />
                    <span className="key-file-name">{keyFileLabel}</span>
                    <button
                        className="clear-file"
                        onClick={() => { setKeyFile({ kind: 'none' }); setError(null); }}
                        title="Remove key file" aria-label="Remove key file"
                    >
                        ×
                    </button>
                </div>
            ))}
            {window.electron && (hardwareKey.kind === 'none' ? (
                hardwareKeyPresent && (
                    <button className="add-key-file" onClick={selectHardwareKey} type="button">
                        <UsbKeyIcon className="key-file-icon" />
                        Hardware key (optional)
                    </button>
                )
            ) : (
                <div className="key-file-chip" title={hardwareKey.kind === 'key' ? `Challenge-response on slot ${hardwareKey.slot}` : undefined}>
                    <UsbKeyIcon className="key-file-icon" />
                    <span className="key-file-name">
                        {hardwareKey.kind === 'key' ? hardwareKey.label : 'Current hardware key'}
                    </span>
                    {hardwareKey.kind === 'key' && (
                        <div className="slot-toggle" role="group" aria-label="Hardware key slot">
                            {([1, 2] as const).map(slot => (
                                <button
                                    key={slot}
                                    className={hardwareKey.slot === slot ? 'active' : ''}
                                    aria-pressed={hardwareKey.slot === slot}
                                    onClick={() => setHardwareKey({ ...hardwareKey, slot })}
                                    title={`Use slot ${slot}`} aria-label={`Use slot ${slot}`}
                                >
                                    {slot}
                                </button>
                            ))}
                        </div>
                    )}
                    <button
                        className="clear-file"
                        onClick={() => { setHardwareKey({ kind: 'none' }); setError(null); }}
                        title="Remove hardware key" aria-label="Remove hardware key"
                    >
                        ×
                    </button>
                </div>
            ))}
            {keyFile.kind !== 'none' && (
                <p className="master-key-note">Losing the key file means losing the vault.</p>
            )}
            {error && <p className="master-key-error" role="alert">{error}</p>}
            <div className="pairing-actions">
                <button className="pairing-cancel-button" onClick={onClose} disabled={busy}>Cancel</button>
                <button className="pairing-allow-button" onClick={() => void submit()} disabled={busy || !currentPw || !newPw || !confirmPw}>
                    {busy ? 'Re-encrypting...' : 'Change master key'}
                </button>
            </div>
        </Modal>
    );
};

import { useEffect, useState } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Modal } from './Modal';
import { KeyActionIcon, UsbKeyIcon } from '../icons/actions/ActionIcons';
import {
    HardwareKeySelection,
    KeyFileSelection,
    buildCredentials,
    hardwareKeyErrorMessage,
    hardwareKeyLabel,
    keyFileName,
    rememberedKeyMaterial
} from '../services/VaultCredentials';
import './BrowserPairingDialog.css';
import './Authentication/AuthenticationView.css';

interface RekeyDialogProps {
    // The vault this is recovering, so the key file and hardware key it was
    // last unlocked with can be offered again
    databasePath: string | null;
    // Whether the vault holds edits that have not reached the file yet. Only
    // then is there anything for the merge to preserve, and only then is
    // cancelling costly enough to say so
    hasUnsavedChanges: boolean;
    // The plain password rides along for biometric unlock, which stores it and
    // is still holding the one this vault has stopped taking
    onSubmit: (credentials: kdbxweb.Credentials, password: string, keyMaterial: KeyMaterial) => void;
    onCancel: () => void;
    // Set when the credentials just tried did not open the file, so the dialog
    // can say so without the caller closing and reopening it
    error?: string;
}

export interface KeyMaterial {
    keyFile: KeyFileSelection | null;
    hardwareKey: HardwareKeySelection | null;
}

// The vault on disk no longer opens with the key this window holds, and the
// file itself is intact, so the master password was changed somewhere else.
// Nothing can be saved until the vault adopts the new key, and overwriting is
// not offered: it would put the old password back and discard whatever the
// other device wrote.
//
// The key file and hardware key are asked for as well as the password. The
// composite key is what opens the file, so a password alone never would, and
// the change made elsewhere may have altered those parts too.
export const RekeyDialog = ({ databasePath, hasUnsavedChanges, onSubmit, onCancel, error }: RekeyDialogProps) => {
    const [password, setPassword] = useState('');
    // What this vault was last unlocked with, as the starting point: a re-key
    // elsewhere usually leaves the key file and hardware key alone, and both
    // can still be changed here if it did not
    const [keyFile, setKeyFile] = useState<KeyFileSelection | null>(() => rememberedKeyMaterial(databasePath).keyFile);
    const [hardwareKey, setHardwareKey] = useState<HardwareKeySelection | null>(() => rememberedKeyMaterial(databasePath).hardwareKey);
    const [hardwareKeyPresent, setHardwareKeyPresent] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);

    // Only offered when a key is plugged in, and probed once: this dialog is
    // raised on a vault that was already unlocked, so whatever it needs is
    // most likely still in the port
    useEffect(() => {
        if (!window.electron?.isHardwareKeyPresent) return;
        let cancelled = false;
        window.electron.isHardwareKeyPresent()
            .then((present) => { if (!cancelled) setHardwareKeyPresent(present); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    const selectKeyFile = async () => {
        const result = await window.electron?.selectKeyFile();
        if (result?.filePath) {
            setKeyFile({ path: result.filePath, name: keyFileName(result.filePath) });
            setLocalError(null);
        }
    };

    const selectHardwareKey = async () => {
        if (!window.electron) return;
        const result = await window.electron.listHardwareKeys();
        if (result.blocked) {
            setLocalError(hardwareKeyErrorMessage('HARDWARE_KEY_ACCESS_DENIED'));
            return;
        }
        const key = result.keys[0];
        if (!key) {
            setLocalError(hardwareKeyErrorMessage('HARDWARE_KEY_NOT_FOUND'));
            return;
        }
        setHardwareKey({ serial: key.serial, slot: 1, label: hardwareKeyLabel(key.serial) });
        setLocalError(null);
    };

    const submit = async () => {
        setLocalError(null);
        let credentials: kdbxweb.Credentials;
        try {
            credentials = await buildCredentials(password, keyFile, hardwareKey);
        } catch (err) {
            setLocalError(err instanceof Error && err.message === 'KEYFILE_READ_FAILED'
                ? `Failed to read key file ${keyFile?.path}; select it again`
                : 'The key file could not be read');
            return;
        }
        onSubmit(credentials, password, { keyFile, hardwareKey });
    };

    const shown = localError ?? error;

    return (
        <Modal
            overlayClassName="pairing-overlay"
            quietInitialFocus
            className="pairing-dialog"
            labelledBy="rekey-title"
            onClose={onCancel}
        >
            <h3 id="rekey-title">The master password was changed</h3>
            <p>
                This vault was re-encrypted somewhere else, most likely on another
                device. Enter the new master password to carry on here.
            </p>
            {hasUnsavedChanges && (
                <p>Your unsaved changes are kept and merged in once it opens.</p>
            )}
            <input
                type="password"
                autoFocus
                value={password}
                placeholder="New master password"
                aria-label="New master password"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && password) void submit(); }}
            />
            {window.electron && (keyFile ? (
                <div className="key-file-chip" title={keyFile.path}>
                    <KeyActionIcon className="key-file-icon" />
                    <span className="key-file-name">{keyFile.name}</span>
                    <button
                        className="clear-file"
                        onClick={() => { setKeyFile(null); setLocalError(null); }}
                        title="Remove key file" aria-label="Remove key file"
                    >
                        ×
                    </button>
                </div>
            ) : (
                <button className="add-key-file" onClick={selectKeyFile} type="button">
                    <KeyActionIcon className="key-file-icon" />
                    Key file (optional)
                </button>
            ))}
            {window.electron && (hardwareKey ? (
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
                        onClick={() => { setHardwareKey(null); setLocalError(null); }}
                        title="Remove hardware key" aria-label="Remove hardware key"
                    >
                        ×
                    </button>
                </div>
            ) : hardwareKeyPresent ? (
                <button className="add-key-file" onClick={selectHardwareKey} type="button">
                    <UsbKeyIcon className="key-file-icon" />
                    Hardware key (optional)
                </button>
            ) : null)}
            {shown && <p role="alert">{shown}</p>}
            <div className="pairing-actions">
                <button onClick={onCancel}>Not now</button>
                <button className="primary" onClick={() => void submit()} disabled={!password}>
                    Unlock and merge
                </button>
            </div>
        </Modal>
    );
};

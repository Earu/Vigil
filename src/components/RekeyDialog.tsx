import { useState } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Modal } from './Modal';
import './BrowserPairingDialog.css';

interface RekeyDialogProps {
    // Whether the vault holds edits that have not reached the file yet. Only
    // then is there anything for the merge to preserve, and only then is
    // cancelling costly enough to say so
    hasUnsavedChanges: boolean;
    onSubmit: (credentials: kdbxweb.Credentials) => void;
    onCancel: () => void;
    // Set when the password just tried did not open the file, so the dialog
    // can say so without the caller closing and reopening it
    error?: string;
}

// The vault on disk no longer opens with the key this window holds, and the
// file itself is intact, so the master password was changed somewhere else.
// Nothing can be saved until the vault adopts the new key, and overwriting is
// not offered: it would put the old password back and discard whatever the
// other device wrote.
export const RekeyDialog = ({ hasUnsavedChanges, onSubmit, onCancel, error }: RekeyDialogProps) => {
    const [password, setPassword] = useState('');

    const submit = () => {
        onSubmit(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
    };

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
                onKeyDown={(e) => { if (e.key === 'Enter' && password) submit(); }}
            />
            {error && <p role="alert">{error}</p>}
            <div className="pairing-actions">
                <button onClick={onCancel}>Not now</button>
                <button className="primary" onClick={submit} disabled={!password}>
                    Unlock and merge
                </button>
            </div>
        </Modal>
    );
};

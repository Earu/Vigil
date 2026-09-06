import { useState } from 'react';
import { PasskeyConsentRequest } from '../services/BrowserIntegrationService';
import { Modal } from './Modal';
import './PasskeyConsentDialog.css';

interface PasskeyConsentDialogProps {
    request: PasskeyConsentRequest;
    // register: any non-null string approves; get: the chosen credentialId
    onSubmit: (credentialId: string) => void;
    onCancel: () => void;
}

export const PasskeyConsentDialog = ({ request, onSubmit, onCancel }: PasskeyConsentDialogProps) => {
    const entries = request.entries ?? [];
    const [selected, setSelected] = useState(entries[0]?.credentialId ?? '');

    const isRegister = request.kind === 'register';
    // A registration for an account this database already holds a passkey
    // for replaces it: the old key stops signing in once the new one is
    // stored, so the dialog says which entry that is, as KeePassXC does
    const replaces = isRegister ? request.replaces : undefined;

    return (
        <Modal overlayClassName="pairing-overlay" quietInitialFocus className="pairing-dialog passkey-dialog" labelledBy="passkey-title" onClose={onCancel}>
                <h3 id="passkey-title">{isRegister ? (replaces ? 'Replace Passkey' : 'Create Passkey') : 'Use Passkey'}</h3>
                {isRegister && replaces ? (
                    <p>
                        <strong>{request.rpId}</strong> wants to create a passkey
                        {request.username ? <> for <strong>{request.username}</strong></> : null},
                        and this database already holds one for that account in <strong>{replaces.title}</strong>.
                        Continuing replaces it: the current passkey stops working for this site,
                        and the old key remains only in the entry's history.
                    </p>
                ) : isRegister ? (
                    <p>
                        <strong>{request.rpId}</strong> wants to create a passkey
                        {request.username ? <> for <strong>{request.username}</strong></> : null}.
                        It will be stored in this database.
                    </p>
                ) : (
                    <p>
                        <strong>{request.rpId}</strong> is asking to sign in with a passkey
                        from this database.
                    </p>
                )}
                {!isRegister && entries.length > 0 && (
                    <div className="passkey-entry-list">
                        {entries.map((entry) => (
                            <label key={entry.credentialId} className="passkey-entry-row">
                                <input
                                    type="radio"
                                    name="passkey-entry"
                                    checked={selected === entry.credentialId}
                                    onChange={() => setSelected(entry.credentialId)}
                                />
                                <span className="passkey-entry-title">{entry.title}</span>
                                {entry.username && <span className="passkey-entry-username">{entry.username}</span>}
                            </label>
                        ))}
                    </div>
                )}
                <div className="pairing-actions">
                    <button className="pairing-cancel-button" onClick={onCancel}>Deny</button>
                    <button
                        className="pairing-allow-button"
                        disabled={!isRegister && !selected}
                        onClick={() => onSubmit(isRegister ? 'approved' : selected)}
                    >
                        {isRegister ? (replaces ? 'Replace' : 'Create') : 'Sign in'}
                    </button>
                </div>
        </Modal>
    );
};

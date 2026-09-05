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

    return (
        <Modal overlayClassName="pairing-overlay" className="pairing-dialog passkey-dialog" labelledBy="passkey-title" onClose={onCancel}>
                <h3 id="passkey-title">{isRegister ? 'Create Passkey' : 'Use Passkey'}</h3>
                {isRegister ? (
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
                        {isRegister ? 'Create' : 'Sign in'}
                    </button>
                </div>
        </Modal>
    );
};

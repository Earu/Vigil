import { useState } from 'react';
import { AccessConsentRequest } from '../services/BrowserIntegrationService';
import { Modal } from './Modal';
import './PasskeyConsentDialog.css';

interface AccessConsentDialogProps {
    request: AccessConsentRequest;
    // The entries the user granted; with remember, refusals are recorded too
    onSubmit: (allowedIds: string[], remember: boolean) => void;
    onCancel: () => void;
}

export const AccessConsentDialog = ({ request, onSubmit, onCancel }: AccessConsentDialogProps) => {
    const [selected, setSelected] = useState<Set<string>>(new Set(request.entries.map(e => e.id)));
    const [remember, setRemember] = useState(true);

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const deny = () => (remember ? onSubmit([], true) : onCancel());

    return (
        <Modal overlayClassName="pairing-overlay" quietInitialFocus className="pairing-dialog passkey-dialog" labelledBy="access-title" onClose={deny}>
                <h3 id="access-title">Allow Browser Access</h3>
                <p>
                    A browser is asking for the logins matching{' '}
                    <strong>{request.host}</strong>. Unchecked entries are withheld.
                </p>
                <div className="passkey-entry-list">
                    {request.entries.map((entry) => (
                        <label key={entry.id} className="passkey-entry-row">
                            <input
                                type="checkbox"
                                checked={selected.has(entry.id)}
                                onChange={() => toggle(entry.id)}
                            />
                            <span className="passkey-entry-title">{entry.title}</span>
                            {entry.username && <span className="passkey-entry-username">{entry.username}</span>}
                        </label>
                    ))}
                </div>
                <label className="passkey-entry-row access-remember-row">
                    <input
                        type="checkbox"
                        checked={remember}
                        onChange={() => setRemember(r => !r)}
                    />
                    <span className="passkey-entry-title">Remember this decision for {request.host}</span>
                </label>
                <div className="pairing-actions">
                    <button
                        className="pairing-cancel-button"
                        onClick={deny}
                    >
                        Deny
                    </button>
                    <button
                        className="pairing-allow-button"
                        disabled={selected.size === 0}
                        onClick={() => onSubmit([...selected], remember)}
                    >
                        Allow
                    </button>
                </div>
        </Modal>
    );
};

import { useState } from 'react';
import './BrowserPairingDialog.css';

interface BrowserPairingDialogProps {
    fingerprint: string;
    onSubmit: (name: string) => void;
    onCancel: () => void;
}

export const BrowserPairingDialog = ({ fingerprint, onSubmit, onCancel }: BrowserPairingDialogProps) => {
    const [name, setName] = useState('');

    const submit = () => {
        if (name.trim()) onSubmit(name.trim());
    };

    return (
        <div className="pairing-overlay">
            <div className="pairing-dialog">
                <h3>Browser Connection Request</h3>
                <p>
                    A browser extension is asking to connect to this database
                    (key {fingerprint}…). Only allow this if you just initiated
                    it from your browser.
                </p>
                <input
                    type="text"
                    className="pairing-name-input"
                    placeholder="Name this connection (e.g. Firefox)"
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                />
                <div className="pairing-actions">
                    <button className="pairing-cancel-button" onClick={onCancel}>Deny</button>
                    <button className="pairing-allow-button" onClick={submit} disabled={!name.trim()}>
                        Allow
                    </button>
                </div>
            </div>
        </div>
    );
};

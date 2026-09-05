import { useState } from 'react';
import { BrowserIntegrationService } from '../services/BrowserIntegrationService';
import './BrowserPairingDialog.css';

interface BrowserPairingDialogProps {
    fingerprint: string;
    // Pairings the database already holds. Reusing one of these names
    // replaces that pairing's key, so the name step asks before it does
    existingNames: string[];
    onSubmit: (name: string) => void;
    onCancel: () => void;
}

export const BrowserPairingDialog = ({ fingerprint, existingNames, onSubmit, onCancel }: BrowserPairingDialogProps) => {
    const [name, setName] = useState('');
    // The name the user asked to reuse, held while they confirm. Cancelling
    // returns to the name step rather than denying the pairing outright, the
    // way KeePassXC's storeKey re-asks instead of giving up
    const [overwriting, setOverwriting] = useState<string | null>(null);

    const submit = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        if (BrowserIntegrationService.pairingNameCollides(trimmed, existingNames)) {
            setOverwriting(trimmed);
            return;
        }
        onSubmit(trimmed);
    };

    if (overwriting) {
        return (
            <div className="pairing-overlay">
                <div className="pairing-dialog">
                    <h3>Replace existing connection?</h3>
                    <p>
                        This database already has a connection named
                        “{overwriting}”. Replacing it disconnects the browser
                        using it.
                    </p>
                    <div className="pairing-actions">
                        <button className="pairing-cancel-button" onClick={() => setOverwriting(null)}>
                            Pick another name
                        </button>
                        <button className="pairing-allow-button" onClick={() => onSubmit(overwriting)}>
                            Replace
                        </button>
                    </div>
                </div>
            </div>
        );
    }

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
                {existingNames.length > 0 && (
                    <p className="pairing-existing">
                        Already connected: {existingNames.join(', ')}
                    </p>
                )}
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

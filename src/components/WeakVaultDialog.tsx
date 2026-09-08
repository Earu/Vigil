import { useState } from 'react';
import { Modal } from './Modal';
import { WarningIcon } from '../icons/status/StatusIcons';
import { KdfWeakness } from '../services/KeepassDatabaseService';
import './BrowserPairingDialog.css';
import './WeakVaultDialog.css';

interface WeakVaultDialogProps {
    weakness: KdfWeakness;
    // Re-encrypts the vault with the recommended parameters and saves it.
    // True when the write landed
    onReencrypt: () => Promise<boolean>;
    onDismiss: (stopAsking: boolean) => void;
}

const whatIsWrong = (weakness: KdfWeakness): string => {
    switch (weakness.code) {
        case 'old-format':
            return 'It is stored in an old file format that cannot protect your master password properly.';
        case 'aes-kdf':
            return 'An average graphics card can bruteforce its master password easily.';
        case 'low-memory':
        case 'low-work':
            return 'Its master password protection is set far below recommended standards.';
    }
};

// Raised at unlock, ahead of the security report: a vault whose entries are
// all sound is still open to an offline attack if its key derivation is.
export const WeakVaultDialog = ({ weakness, onReencrypt, onDismiss }: WeakVaultDialogProps) => {
    const [stopAsking, setStopAsking] = useState(false);
    const [busy, setBusy] = useState(false);

    const reencrypt = async () => {
        setBusy(true);
        const saved = await onReencrypt();
        // A failed save has already said why; the dialog stays for another try
        if (!saved) setBusy(false);
    };

    return (
        <Modal
            overlayClassName="pairing-overlay"
            quietInitialFocus
            className="pairing-dialog weak-vault-dialog"
            labelledBy="weak-vault-title"
            onClose={busy ? undefined : () => onDismiss(stopAsking)}
        >
            <h3 id="weak-vault-title">
                <WarningIcon className="weak-vault-icon" color="currentColor" />
                This vault is weakly encrypted
            </h3>
            <p>
                {whatIsWrong(weakness)} Someone who gets hold of the file could guess
                their way in far faster than they should be able to.
            </p>
            <p>
                Vigil can re-encrypt it now. Your master password stays the same and
                nothing in the vault changes; unlocking will take about a second.
            </p>
            <label className="weak-vault-remember">
                <input
                    type="checkbox"
                    checked={stopAsking}
                    disabled={busy}
                    onChange={() => setStopAsking(v => !v)}
                />
                <span>Don't remind me for this vault</span>
            </label>
            <div className="pairing-actions">
                <button className="pairing-cancel-button" onClick={() => onDismiss(stopAsking)} disabled={busy}>
                    Not now
                </button>
                <button className="pairing-allow-button" onClick={() => void reencrypt()} disabled={busy}>
                    {busy ? 'Re-encrypting...' : 'Re-encrypt now'}
                </button>
            </div>
        </Modal>
    );
};

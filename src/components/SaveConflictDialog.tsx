import { Modal } from './Modal';
import './BrowserPairingDialog.css';

interface SaveConflictDialogProps {
    message: string;
    onOverwrite: () => void;
    onCancel: () => void;
}

// The save found changes on disk it could not merge. Asked through the
// consent queue rather than window.confirm so the save queue is not blocked
// by a frozen renderer, headless callers get an answer, and an unload cannot
// silently answer no on the user's behalf
export const SaveConflictDialog = ({ message, onOverwrite, onCancel }: SaveConflictDialogProps) => (
    <Modal
        overlayClassName="pairing-overlay"
            quietInitialFocus
        className="pairing-dialog"
        role="alertdialog"
        labelledBy="save-conflict-title"
        describedBy="save-conflict-message"
        onClose={onCancel}
    >
            <h3 id="save-conflict-title">Database Changed on Disk</h3>
            <p id="save-conflict-message">{message}</p>
            <div className="pairing-actions">
                <button className="pairing-cancel-button" onClick={onCancel}>Keep Disk Version</button>
                <button className="pairing-allow-button" onClick={onOverwrite}>Overwrite</button>
            </div>
    </Modal>
);

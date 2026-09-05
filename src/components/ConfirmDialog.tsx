import { Modal } from './Modal';
import './BrowserPairingDialog.css';

export interface ConfirmRequest {
    message: string;
    // The confirming button's label; the safe answer is always "Cancel"
    confirmLabel?: string;
}

interface ConfirmDialogProps {
    request: ConfirmRequest;
    onConfirm: () => void;
    onCancel: () => void;
}

// Replaces window.confirm. A native dialog leaves the window and, on the way
// back, Chromium can lose track of the page being focused: every focus ring
// vanishes until the window is refocused. This one never leaves.
// Cancel is focused first, so Enter is the safe answer
export const ConfirmDialog = ({ request, onConfirm, onCancel }: ConfirmDialogProps) => (
    <Modal
        overlayClassName="pairing-overlay"
        className="pairing-dialog confirm-dialog"
        role="alertdialog"
        labelledBy="confirm-message"
        onClose={onCancel}
    >
        <p id="confirm-message" className="confirm-message">{request.message}</p>
        <div className="pairing-actions">
            <button className="pairing-cancel-button" onClick={onCancel} autoFocus>Cancel</button>
            <button className="pairing-allow-button" onClick={onConfirm}>{request.confirmLabel ?? 'OK'}</button>
        </div>
    </Modal>
);

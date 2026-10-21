import { Modal } from './Modal';
import { WarningIcon } from '../icons/status/StatusIcons';
import './BrowserPairingDialog.css';
import './WeakVaultDialog.css';
import './UpdateDialog.css';

interface UpdateDialogProps {
    version: string;
    onUpdate: () => void;
    onDismiss: () => void;
}

const RELEASES_URL = 'https://github.com/Earu/Vigil/releases/tag/v';

export const UpdateDialog = ({ version, onUpdate, onDismiss }: UpdateDialogProps) => (
    <Modal
        overlayClassName="pairing-overlay"
        quietInitialFocus
        className="pairing-dialog weak-vault-dialog"
        labelledBy="update-title"
        onClose={onDismiss}
    >
        <h3 id="update-title">
            <WarningIcon className="weak-vault-icon" color="currentColor" />
            Vigil {version} is available
        </h3>
        <p>
            Updates can include security fixes. An old version may leave your vault
            exposed to problems that have since been fixed.
        </p>
        <p>The update downloads in the background and installs the next time Vigil closes.</p>
        <button
            className="update-notes-link"
            onClick={() => void window.electron?.openExternal(`${RELEASES_URL}${version}`)}
            type="button"
        >
            What's new in {version}
        </button>
        <div className="pairing-actions">
            <button className="pairing-cancel-button" onClick={onDismiss}>Not now</button>
            <button className="pairing-allow-button" onClick={onUpdate}>Update</button>
        </div>
    </Modal>
);

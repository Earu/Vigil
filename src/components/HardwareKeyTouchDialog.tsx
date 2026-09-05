import { UsbKeyIcon } from '../icons/actions/ActionIcons';
import { Modal } from './Modal';
import './HardwareKeyTouchDialog.css';

// Shown while the YubiKey is blinking and waiting for a touch. It closes on
// its own when the key is touched or the wait times out
export const HardwareKeyTouchDialog = () => (
    <Modal
        overlayClassName="pairing-overlay"
        className="pairing-dialog hardware-key-touch-dialog"
        labelledBy="hardware-key-touch-title"
        describedBy="hardware-key-touch-message"
        initialFocus="container"
    >
            <UsbKeyIcon className="hardware-key-touch-icon" />
            <h3 id="hardware-key-touch-title">Touch your hardware key</h3>
            <p id="hardware-key-touch-message">Your key is blinking. Touch it to continue.</p>
    </Modal>
);

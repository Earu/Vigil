import { UsbKeyIcon } from '../icons/actions/ActionIcons';
import './HardwareKeyTouchDialog.css';

// Shown while the YubiKey is blinking and waiting for a touch. It closes on
// its own when the key is touched or the wait times out
export const HardwareKeyTouchDialog = () => (
    <div className="pairing-overlay">
        <div className="pairing-dialog hardware-key-touch-dialog">
            <UsbKeyIcon className="hardware-key-touch-icon" />
            <h3>Touch your hardware key</h3>
            <p>Your key is blinking. Touch it to continue.</p>
        </div>
    </div>
);

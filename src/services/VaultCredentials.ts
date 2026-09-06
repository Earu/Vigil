import * as kdbxweb from 'kdbxweb';
import { userSettingsService } from './UserSettingsService';

export interface HardwareKeySelection {
    serial: number | null;
    slot: 1 | 2;
    label: string;
}

export interface KeyFileSelection {
    path: string;
    name: string;
}

// Challenge-response against the YubiKey's HMAC-SHA1 slot, KeePassXC scheme.
// kdbxweb calls this on load and on every save (the challenge is derived from
// seeds that regenerate when saving), so touch-required slots prompt each time
export const hardwareKeyChallengeCallback = (serial: number | null, slot: 1 | 2) =>
    async (challenge: ArrayBuffer): Promise<ArrayBuffer> => {
        const result = await window.electron?.hardwareKeyChallenge(serial, slot, challenge);
        if (!result?.success || !result.response) {
            throw new Error(result?.error ?? 'HARDWARE_KEY_FAILED');
        }
        const bytes = new Uint8Array(result.response);
        const out = new ArrayBuffer(bytes.length);
        new Uint8Array(out).set(bytes);
        return out;
    };

export const hardwareKeyLabel = (serial: number | null) => serial != null ? `YubiKey ${serial}` : 'YubiKey';

export const keyFileName = (path: string) => path.split(/[/\\]/).pop() || path;

export const hardwareKeyErrorMessage = (code: string): string => {
    switch (code) {
        case 'HARDWARE_KEY_NOT_FOUND':
            return 'Hardware key not found. Plug in your YubiKey and try again.';
        case 'HARDWARE_KEY_TOUCH_TIMEOUT':
            return 'Hardware key timed out waiting for touch';
        case 'HARDWARE_KEY_TIMEOUT':
            return 'The hardware key did not respond. Is the selected slot configured for challenge-response?';
        case 'HARDWARE_KEY_ACCESS_DENIED':
            return navigator.platform.startsWith('Mac')
                ? 'Hardware key could not be opened. Grant Vigil the Input Monitoring permission in System Settings > Privacy & Security, then relaunch.'
                : 'Hardware key could not be opened. On Linux, install the Yubico udev rules and replug the key.';
        default:
            return 'Hardware key communication failed';
    }
};

// What was remembered for this vault the last time it was unlocked. Anywhere
// that has to open the same file again asks for the same key material, so a
// vault behind a key file or a YubiKey is not left with the password alone
export function rememberedKeyMaterial(dbPath: string | null | undefined): {
    keyFile: KeyFileSelection | null;
    hardwareKey: HardwareKeySelection | null;
} {
    if (!dbPath) return { keyFile: null, hardwareKey: null };
    const path = userSettingsService.getKeyFilePath(dbPath);
    const hw = userSettingsService.getHardwareKey(dbPath);
    return {
        keyFile: path ? { path, name: keyFileName(path) } : null,
        hardwareKey: hw ? { ...hw, label: hardwareKeyLabel(hw.serial) } : null
    };
}

export function rememberKeyMaterial(
    dbPath: string | null | undefined,
    keyFile: KeyFileSelection | null,
    hardwareKey: HardwareKeySelection | null
): void {
    if (!dbPath) return;
    userSettingsService.setKeyFilePath(dbPath, keyFile?.path);
    userSettingsService.setHardwareKey(dbPath, hardwareKey ? { serial: hardwareKey.serial, slot: hardwareKey.slot } : undefined);
}

// The composite key kdbxweb opens the file with. KEYFILE_READ_FAILED is the
// one failure a caller has to phrase for itself: the password had nothing to
// do with it, and retyping it will not help
export async function buildCredentials(
    password: string,
    keyFile: KeyFileSelection | null,
    hardwareKey: HardwareKeySelection | null
): Promise<kdbxweb.Credentials> {
    let keyFileData: ArrayBuffer | undefined;
    if (keyFile) {
        const result = await window.electron?.readFile(keyFile.path);
        if (!result?.success || !result.data) {
            throw new Error('KEYFILE_READ_FAILED');
        }
        // A fresh, exactly-sized buffer per call: setKeyFile overwrites the
        // one it is handed, so a shared buffer yields the right key once and
        // a wrong one every time after
        keyFileData = new Uint8Array(result.data).buffer;
    }
    return new kdbxweb.Credentials(
        kdbxweb.ProtectedValue.fromString(password),
        keyFileData,
        hardwareKey ? hardwareKeyChallengeCallback(hardwareKey.serial, hardwareKey.slot) : undefined
    );
}

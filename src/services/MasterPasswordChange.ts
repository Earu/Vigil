import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService, PendingCredentialChange } from './KeepassDatabaseService';

// What became of biometric unlock: 'off' means it was turned off here,
// with the reason in `reason`; 'kept' means the save failed, the old
// password is back in force and whatever unlock was set up still fits it
export type PasswordChangeOutcome = {
    saved: boolean;
    biometrics: 'not-enabled' | 'resealed' | 'off' | 'kept';
    reason?: string;
};

type BiometricsBridge = Pick<NonNullable<typeof window.electron>, 'hasBiometricsEnabled' | 'enableBiometrics' | 'disableBiometrics'>;

// Biometric unlock stores the master password, so a change has to reach it
// too, and in the right order: the file must accept the new password before
// it is sealed. A re-seal that fails (a cancelled Windows Hello prompt, a
// keychain error) leaves the old password sealed, still releasable by a
// fingerprint, so the setup is torn down rather than left holding a
// password the user just rotated.
//
// The new password is handed to the save rather than applied here, and the
// save puts it in place after it has read and merged whatever is on disk.
// Applying it up front left the credentials disagreeing with the file for the
// length of the save: the merge opened the old file with the new key, failed,
// and offered to overwrite another machine's changes. The save also reverts
// on failure, so a change the user was told did not take cannot re-encrypt
// the file on the next save of anything
export async function changeMasterPassword(
    newPassword: string,
    save: (rekeyTo: PendingCredentialChange) => Promise<boolean>,
    bridge: BiometricsBridge | undefined = window.electron,
    dbPath: string | undefined = KeepassDatabaseService.getPath()
): Promise<PasswordChangeOutcome> {
    let enabled = false;
    if (bridge && dbPath) {
        try {
            const bio = await bridge.hasBiometricsEnabled(dbPath);
            enabled = bio.success && !!bio.enabled;
        } catch (err) {
            console.error('Failed to check biometrics status:', err);
        }
    }

    let saved: boolean;
    try {
        saved = await save({ password: kdbxweb.ProtectedValue.fromString(newPassword) });
    } catch {
        saved = false;
    }

    if (!saved) {
        // The save put the old key back; nothing to undo here
        return { saved, biometrics: enabled ? 'kept' : 'not-enabled' };
    }

    if (!enabled || !bridge || !dbPath) return { saved, biometrics: 'not-enabled' };

    return { saved, ...await reseal(bridge, dbPath, newPassword) };
}

// Seals a password that is already in force on the file. A re-seal that fails
// leaves the old one sealed, still releasable by a fingerprint, so the setup
// is torn down rather than left holding a password the user just rotated
async function reseal(
    bridge: BiometricsBridge,
    dbPath: string,
    newPassword: string
): Promise<{ biometrics: 'resealed' | 'off'; reason?: string }> {
    try {
        const sealed = await bridge.enableBiometrics(dbPath, newPassword);
        if (sealed.success) return { biometrics: 'resealed' };
        await turnOff(bridge, dbPath);
        return { biometrics: 'off', reason: sealed.error || 'the new password could not be stored for biometric unlock' };
    } catch (err) {
        console.error('Failed to refresh biometric credentials:', err);
        await turnOff(bridge, dbPath);
        return { biometrics: 'off', reason: 'the new password could not be stored for biometric unlock' };
    }
}

// The same, for a password change made on another device and adopted here.
// Nothing was set up in this window, so whether biometric unlock holds
// anything has to be asked first; left alone it would keep releasing the
// password this vault has stopped taking, and go on holding a rotated one
export async function resealBiometrics(
    newPassword: string,
    bridge: BiometricsBridge | undefined = window.electron,
    dbPath: string | undefined = KeepassDatabaseService.getPath()
): Promise<{ biometrics: PasswordChangeOutcome['biometrics']; reason?: string }> {
    if (!bridge || !dbPath) return { biometrics: 'not-enabled' };
    try {
        const bio = await bridge.hasBiometricsEnabled(dbPath);
        if (!bio.success || !bio.enabled) return { biometrics: 'not-enabled' };
    } catch (err) {
        console.error('Failed to check biometrics status:', err);
        return { biometrics: 'not-enabled' };
    }
    return reseal(bridge, dbPath, newPassword);
}

async function turnOff(bridge: BiometricsBridge, dbPath: string): Promise<void> {
    try {
        await bridge.disableBiometrics(dbPath);
    } catch (err) {
        console.error('Failed to disable biometrics:', err);
    }
}

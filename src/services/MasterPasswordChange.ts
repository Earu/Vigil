import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';

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
// A save that fails leaves the file on the old password, so the old key
// goes back in force here too. Left in place, the new key would apply to
// the next save of anything, quietly re-encrypting the file under a
// password the user was told did not take; the on-disk version would stop
// merging, and a retry of the change would fail its own verification
export async function changeMasterPassword(
    kdbxDb: kdbxweb.Kdbx,
    newPassword: string,
    save: () => Promise<boolean>,
    bridge: BiometricsBridge | undefined = window.electron,
    dbPath: string | undefined = KeepassDatabaseService.getPath()
): Promise<PasswordChangeOutcome> {
    const previousHash = kdbxDb.credentials.passwordHash;
    await KeepassDatabaseService.changeMasterPassword(kdbxDb, newPassword);

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
        saved = await save();
    } catch {
        saved = false;
    }

    if (!saved) {
        kdbxDb.credentials.passwordHash = previousHash;
        return { saved, biometrics: enabled ? 'kept' : 'not-enabled' };
    }

    if (!enabled || !bridge || !dbPath) return { saved, biometrics: 'not-enabled' };

    try {
        const sealed = await bridge.enableBiometrics(dbPath, newPassword);
        if (sealed.success) return { saved, biometrics: 'resealed' };
        await turnOff(bridge, dbPath);
        return { saved, biometrics: 'off', reason: sealed.error || 'the new password could not be stored for biometric unlock' };
    } catch (err) {
        console.error('Failed to refresh biometric credentials:', err);
        await turnOff(bridge, dbPath);
        return { saved, biometrics: 'off', reason: 'the new password could not be stored for biometric unlock' };
    }
}

async function turnOff(bridge: BiometricsBridge, dbPath: string): Promise<void> {
    try {
        await bridge.disableBiometrics(dbPath);
    } catch (err) {
        console.error('Failed to disable biometrics:', err);
    }
}

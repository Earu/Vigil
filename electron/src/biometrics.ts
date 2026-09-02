import { systemPreferences } from 'electron';
import { execSync } from 'child_process';
import { createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import keytar from './get-keytar';
import {
    isV2Blob,
    isV3Blob,
    makeChallenge,
    deriveKeyFromSignature,
    sealPassword,
    challengeFromBlob,
    openPassword,
    sealWithKeychainKey,
    openWithKeychainKey
} from './biometrics-crypto';

// Biometry-gated keychain addon (macOS). Reports 'unavailable' on every call
// when the binary is missing, so the import is safe on every platform
import * as touchid from '../native/touchid';

let Passport: any;
if (process.platform === 'win32') {
    const { Passport: WindowsPassport } = require('passport-desktop');
    Passport = WindowsPassport;
}

const SERVICE_NAME = 'Vigil Password Manager';
const SALT_PATH = path.join(app.getPath('userData'), '.salt');
// Account used only to find out whether this build may write entitlement
// gated keychain items; never holds anything meaningful
const ENTITLEMENT_PROBE_ACCOUNT = '__vigil_entitlement_probe__';

let biometricsAvailableCache: boolean | null = null;

// Tests exercise both macOS backends in one process
export function resetForTests(): void {
    biometricsAvailableCache = null;
    macBackendProbe = null;
}

function generateNewSalt(): string {
    const buffer = Buffer.alloc(32);
    require('crypto').randomFillSync(buffer);
    return buffer.toString('hex');
}

async function getInstallationSalt(): Promise<string> {
    try {
        if (fs.existsSync(SALT_PATH)) {
            return await fs.promises.readFile(SALT_PATH, 'utf-8');
        }

        const newSalt = generateNewSalt();
        await fs.promises.writeFile(SALT_PATH, newSalt, { mode: 0o600 });
        return newSalt;
    } catch (error) {
        console.error('Failed to manage installation salt:', error);
        return generateNewSalt();
    }
}

async function generateUniqueKey(dbPath: string): Promise<string> {
    const salt = await getInstallationSalt();
    return `${dbPath}_${salt}`;
}

export async function isBiometricsAvailable(): Promise<boolean> {
    if (!keytar) {
        console.warn('Keytar is not available');
        return false;
    }

    if (biometricsAvailableCache !== null) {
        return biometricsAvailableCache;
    }

    try {
        if (process.platform === 'darwin') {
            biometricsAvailableCache = systemPreferences.canPromptTouchID();
        } else if (process.platform === 'win32') {
            biometricsAvailableCache = Passport.available();
        } else {
            biometricsAvailableCache = false;
        }
    } catch (error) {
        console.error('Error checking biometrics availability:', error);
        biometricsAvailableCache = false;
    }

    return biometricsAvailableCache || false;
}

// macOS Touch ID prompt on its own. This is a UI gate, not a cryptographic
// one: nothing about the stored password depends on it passing. It survives
// only to front the one-time upgrade of a legacy blob (see
// getBiometricPassword); the scheme that relied on it is no longer written.
// Windows does not use this: there the Hello prompt itself produces the key
// (getWindowsHelloKey)
async function authenticateWithBiometrics(data: { dbPath: string, dbName: string }): Promise<boolean> {
    if (process.platform === 'darwin') {
        try {
            await systemPreferences.promptTouchID(`unlock ${data.dbName} with biometrics`);
            return true;
        } catch (error) {
            console.error('TouchID authentication failed:', error);
            return false;
        }
    }
    return false;
}

// macOS with the native addon: the master password is sealed under a random
// key held in a biometry-gated keychain item, so the OS enforces the Touch ID
// check before the key material exists in this process. This is the macOS
// equivalent of the Windows Hello path, and unlike the legacy scheme below
// the ciphertext is not openable by anything that can read the disk.
export type MacBiometricBackend = 'secure' | 'gate';

let macBackendProbe: Promise<MacBiometricBackend> | null = null;

// Whether the data protection keychain will accept a write from this build.
// It only does for a build signed with the application-identifier and
// keychain-access-groups entitlements a provisioning profile authorizes
// (Apple TN3137); unsigned and ad-hoc signed builds get
// errSecMissingEntitlement. The answer cannot change while the app runs, and
// the only way to ask is to try, so probe once with a throwaway item
async function probeMacBackend(): Promise<MacBiometricBackend> {
    if (!touchid.isLoaded() || !touchid.availability().usable) {
        console.info('Biometric backend: none (Touch ID addon unavailable)');
        return 'gate';
    }
    const written = await touchid.setSecret(ENTITLEMENT_PROBE_ACCOUNT, randomBytes(32));
    if (!written.ok) {
        console.info(`Biometric backend: none (keychain rejected the probe: ${written.code})`);
        return 'gate';
    }
    await touchid.deleteSecret(ENTITLEMENT_PROBE_ACCOUNT);
    console.info('Biometric backend: hardware (biometry-gated keychain)');
    return 'secure';
}

function getMacBackend(): Promise<MacBiometricBackend> {
    if (!macBackendProbe) {
        macBackendProbe = probeMacBackend().catch((error) => {
            console.error('Touch ID keychain probe failed:', error);
            return 'gate' as const;
        });
    }
    return macBackendProbe;
}

// Store the wrapping key, then read it straight back. The read is what asks
// the user for Touch ID, so enabling is confirmed by the same check that will
// later unlock, and a keychain item the OS accepted but cannot actually
// release is caught here instead of at unlock time
async function enableSecureMac(account: string, dbName: string):
    Promise<{ wrappingKey: Buffer } | { error: string } | null> {
    const wrappingKey = randomBytes(32);
    const written = await touchid.setSecret(account, wrappingKey);
    if (!written.ok) {
        console.error('Touch ID keychain write failed:', written.code, written.status ?? '');
        return null;
    }

    const readBack = await touchid.getSecret(account, `confirm biometric unlock for ${dbName}`);
    if (!readBack.ok) {
        await touchid.deleteSecret(account);
        if (readBack.code === 'canceled') {
            return { error: 'Biometric authentication was cancelled' };
        }
        // Anything else means the round trip is not trustworthy on this
        // machine. The caller refuses to enable: storing a blob only a broken
        // keychain item can open helps nobody, and no weaker scheme is offered
        console.error('Touch ID keychain read-back failed:', readBack.code, readBack.status ?? '');
        return null;
    }
    if (!readBack.data.equals(wrappingKey)) {
        await touchid.deleteSecret(account);
        console.error('Touch ID keychain returned a different key than it stored');
        return null;
    }

    return { wrappingKey };
}

// Windows: derive the sealing key from a Windows Hello signature over the
// stored challenge. Signing requires a live Hello verification and the
// RSA PKCS#1 v1.5 signature is deterministic, so the same challenge always
// re-derives the same key, but only after the user passes Hello. Replaces
// the old hardware-id derivation (which also depended on wmic, removed in
// Windows 11 24H2)
async function getWindowsHelloKey(dbPath: string, challenge: Buffer): Promise<Buffer> {
    const passport = new Passport(dbPath);
    if (!passport.accountExists) {
        await passport.createAccount();
    }
    const signature: Buffer = await passport.sign(challenge);
    return deriveKeyFromSignature(signature);
}

// Legacy macOS scheme, read side only. Blobs written by earlier versions are
// sealed under PBKDF2(hardware UUID, on-disk salt): a key any process running
// as the user can rebuild, so the Touch ID prompt in front of it protected
// nothing. Nothing writes this format any more; it is opened exactly once, to
// re-seal the password under the keychain, and only by a build that can.
// There is no fallback identifier: the old one (user name plus host name) was
// public, and a blob this cannot open is one to discard, not to guess at
async function getHardwareId(): Promise<string> {
    const output = execSync('system_profiler SPHardwareDataType | grep "Hardware UUID"').toString();
    const hardwareUUID = output.split(':')[1]?.trim();
    if (!hardwareUUID) throw new Error('Hardware UUID not reported');
    return hardwareUUID;
}

async function deriveEncryptionKey(hardwareId: string, salt: string): Promise<Buffer> {
    return pbkdf2Sync(hardwareId, salt, 100000, 32, 'sha512');
}

async function decryptPassword(encryptedData: string): Promise<string> {
    const hardwareId = await getHardwareId();
    const salt = await getInstallationSalt();
    const key = await deriveEncryptionKey(hardwareId, salt);
    const data = Buffer.from(encryptedData, 'base64');
    const iv = data.subarray(0, 16);
    const authTag = data.subarray(16, 32);
    const encrypted = data.subarray(32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
}

// A macOS blob in the legacy format is a stored master password that a
// Touch ID prompt only pretends to guard. Whether it may stay depends on the
// build: one that can reach the biometry-gated keychain re-seals it at the
// next unlock; one that cannot has nothing better to offer, so the blob goes
const LEGACY_MAC_UNSUPPORTED = 'Biometric unlock was turned off: this build cannot protect the saved password. Enable it again on a signed build of Vigil';

// Why a Mac with a working sensor still gets no biometric unlock: the
// biometry-gated keychain only accepts writes from a build signed with the
// entitlements a provisioning profile authorizes. Shown to the user, since
// from where they sit the sensor works and the option is simply missing
const MAC_UNSIGNED_BUILD = 'Biometric unlock needs a signed build of Vigil: this build cannot keep the key in the biometry-gated keychain';

async function discardLegacyMacBlob(key: string): Promise<void> {
    console.warn('Discarding a legacy biometric blob this build cannot protect');
    await keytar?.deletePassword(SERVICE_NAME, key);
}

// `hardwareBacked` says what protects the stored password right now, so the
// UI can show the state of the blob rather than the capability of the build
export async function hasBiometricsEnabled(dbPath: string): Promise<{ success: boolean, error?: string, enabled?: boolean, hardwareBacked?: boolean }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, key);
        if (!stored) return { success: true, enabled: false };

        if (process.platform === 'darwin') {
            if (isV3Blob(stored)) return { success: true, enabled: true, hardwareBacked: true };
            if (await getMacBackend() !== 'secure') {
                await discardLegacyMacBlob(key);
                return { success: true, enabled: false };
            }
            return { success: true, enabled: true, hardwareBacked: false };
        }
        if (process.platform === 'win32') {
            return { success: true, enabled: true, hardwareBacked: isV2Blob(stored) };
        }
        return { success: true, enabled: true };
    } catch (error) {
        console.error('Failed to check biometrics status:', error);
        return { success: false, error: 'Failed to check biometrics status' };
    }
}

export async function enableBiometrics(dbPath: string, password: string): Promise<{ success: boolean, error?: string }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);

        if (process.platform === 'win32') {
            // The sign call is the Hello verification; a cancelled prompt
            // throws and nothing is stored
            const challenge = makeChallenge();
            const helloKey = await getWindowsHelloKey(dbPath, challenge);
            await keytar?.setPassword(SERVICE_NAME, key, sealPassword(password, challenge, helloKey));
            return { success: true };
        }

        if (process.platform !== 'darwin') {
            return { success: false, error: 'Biometric authentication is not available on this platform' };
        }

        // The keychain is the only place the password may be sealed to. A
        // build the keychain refuses gets no unlock rather than a weaker one:
        // the old fallback stored the password under a key the whole user
        // account could derive, behind a prompt that decided nothing
        if (await getMacBackend() !== 'secure') {
            return { success: false, error: MAC_UNSIGNED_BUILD };
        }

        const dbName = dbPath.split('/').pop() as string;
        const sealed = await enableSecureMac(key, dbName);
        if (!sealed) {
            // The keychain took the key and would not give it back. That is a
            // hard failure: enabling anyway would either store a blob only a
            // broken keychain item can open, or fall back to the scheme above
            return { success: false, error: 'Could not set up biometric unlock: the keychain did not release the key it stored' };
        }
        if ('error' in sealed) return { success: false, error: sealed.error };

        await keytar?.setPassword(SERVICE_NAME, key, sealWithKeychainKey(password, sealed.wrappingKey));
        return { success: true };
    } catch (error) {
        console.error('Failed to enable biometrics:', error);
        return { success: false, error: 'Failed to enable biometric authentication' };
    }
}

// `retry` says the stored credential is still good and only this attempt
// failed (cancelled prompt, unrecognised finger). Without it the caller cannot
// tell that apart from credentials that can never be opened again, and tearing
// the user's biometric setup down every time they dismiss a prompt is wrong
export async function getBiometricPassword(dbPath: string):
    Promise<{ success: boolean, error?: string, password?: string, retry?: boolean }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, key);
        if (!stored) {
            return { success: false, error: 'No password found for this database' };
        }

        if (process.platform === 'win32') {
            if (!isV2Blob(stored)) {
                // Sealed under the old hardware-id scheme, whose key material
                // this version no longer derives. Drop it so the UI falls back
                // to password; the user re-enables in settings
                await keytar?.deletePassword(SERVICE_NAME, key);
                return { success: false, error: 'Biometric unlock was upgraded, please enable it again in settings' };
            }
            let helloKey: Buffer;
            try {
                helloKey = await getWindowsHelloKey(dbPath, challengeFromBlob(stored));
            } catch (error) {
                // Cancelled or failed Hello prompt; the stored blob stays
                console.error('Windows Hello authentication failed:', error);
                return { success: false, error: 'Biometric authentication failed', retry: true };
            }
            try {
                return { success: true, password: openPassword(stored, helloKey) };
            } catch {
                // Decryption failure means the Hello key changed (e.g. Hello
                // was reset); the blob is unrecoverable
                await keytar?.deletePassword(SERVICE_NAME, key);
                return { success: false, error: 'Biometric data is stale, please enable biometric unlock again' };
            }
        }

        const dbName = dbPath.split('/').pop() as string;

        if (process.platform === 'darwin' && isV3Blob(stored)) {
            // Sealed against the keychain item, so only the item can open it.
            // The read is the Touch ID prompt
            const wrappingKey = await touchid.getSecret(key, `unlock ${dbName} with biometrics`);
            if (!wrappingKey.ok) {
                if (wrappingKey.code === 'not-found') {
                    // The item is gone, which is what macOS does when the
                    // enrolled fingerprints change (BiometryCurrentSet). The
                    // blob can never be opened again
                    await keytar?.deletePassword(SERVICE_NAME, key);
                    return { success: false, error: 'Biometric enrollment changed, please enable biometric unlock again' };
                }
                if (wrappingKey.code === 'canceled') {
                    return { success: false, error: 'Biometric authentication was cancelled', retry: true };
                }
                // missing-entitlement or unavailable means this build cannot
                // reach the item an earlier build wrote. Keep the blob: a
                // properly signed build will open it again
                console.error('Touch ID keychain read failed:', wrappingKey.code, wrappingKey.status ?? '');
                return { success: false, error: 'Biometric authentication failed', retry: true };
            }
            try {
                return { success: true, password: openWithKeychainKey(stored, wrappingKey.data) };
            } catch {
                await keytar?.deletePassword(SERVICE_NAME, key);
                return { success: false, error: 'Biometric data is stale, please enable biometric unlock again' };
            }
        }

        if (process.platform !== 'darwin') {
            return { success: false, error: 'Biometric authentication is not available on this platform' };
        }

        // Legacy blob. Only a build that can re-seal it under the keychain
        // may open it, and then only to do that; any other build discards it
        if (await getMacBackend() !== 'secure') {
            await discardLegacyMacBlob(key);
            return { success: false, error: LEGACY_MAC_UNSUPPORTED };
        }

        if (!await authenticateWithBiometrics({ dbPath, dbName })) {
            return { success: false, error: 'Biometric authentication failed', retry: true };
        }

        let password: string;
        try {
            password = await decryptPassword(stored);
        } catch (error) {
            // The hardware identifier is gone or the blob does not open under
            // it; there is no other key to try
            console.error('Legacy biometric blob could not be opened:', error);
            await keytar?.deletePassword(SERVICE_NAME, key);
            return { success: false, error: 'Biometric data is stale, please enable biometric unlock again' };
        }

        // Re-seal under the keychain so the next unlock is enforced by the OS.
        // The unlock itself goes ahead either way, but the legacy blob does
        // not survive it: if the upgrade fails the user re-enables, rather
        // than keep a copy of the password that nothing protects
        try {
            const wrappingKey = randomBytes(32);
            const written = await touchid.setSecret(key, wrappingKey);
            if (!written.ok) throw new Error(`keychain write failed: ${written.code}`);
            await keytar?.setPassword(SERVICE_NAME, key, sealWithKeychainKey(password, wrappingKey));
        } catch (error) {
            console.error('Failed to upgrade biometric storage, discarding the legacy blob:', error);
            await keytar?.deletePassword(SERVICE_NAME, key);
        }

        return { success: true, password };
    } catch (error) {
        console.error('Failed to get password with biometrics:', error);
        return { success: false, error: 'Failed to authenticate with biometrics', retry: true };
    }
}

export async function disableBiometrics(dbPath: string): Promise<{ success: boolean, error?: string }> {
    try {
        const key = await generateUniqueKey(dbPath);
        await keytar?.deletePassword(SERVICE_NAME, key);
        if (process.platform === 'darwin') {
            // Best effort: drop the keychain item too so no biometry-gated
            // key outlives the database it unlocked
            await touchid.deleteSecret(key);
        }
        if (process.platform === 'win32') {
            // Best effort: also drop the Hello signing key so nothing lingers
            try {
                const passport = new Passport(dbPath);
                if (passport.accountExists) await passport.deleteAccount();
            } catch { /* account already gone */ }
        }
        return { success: true };
    } catch (error) {
        console.error('Failed to disable biometrics:', error);
        return { success: false, error: 'Failed to disable biometric authentication' };
    }
}

// 'hardware' is the only backend a password is ever stored under: the OS
// releases the key after a biometric check it enforces itself. A platform
// without that has no biometric unlock, and says why
export type BiometricsBackend = 'hardware' | 'none';

export async function getBiometricsInfo(): Promise<{
    available: boolean,
    backend: BiometricsBackend,
    biometryType: string,
    unavailableReason?: string
}> {
    const available = await isBiometricsAvailable();
    if (!available) return { available: false, backend: 'none', biometryType: 'none' };

    if (process.platform === 'win32') {
        return { available: true, backend: 'hardware', biometryType: 'windows-hello' };
    }

    if (process.platform === 'darwin') {
        const biometryType = touchid.availability().biometryType;
        if (await getMacBackend() !== 'secure') {
            return { available: false, backend: 'none', biometryType, unavailableReason: MAC_UNSIGNED_BUILD };
        }
        return { available: true, backend: 'hardware', biometryType };
    }

    return { available: false, backend: 'none', biometryType: 'none' };
}

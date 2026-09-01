import { systemPreferences } from 'electron';
import { execSync } from 'child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
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
// when the binary is missing, so the require is safe on every platform
const touchid = require('../native/touchid');

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

// macOS fallback path: gates access with a Touch ID prompt. This is a UI
// gate, not a cryptographic one, and the key it guards is derived from the
// hardware UUID plus an on-disk salt, so anything that can read both can open
// the blob without ever meeting the prompt. Only used when the keychain addon
// cannot store a biometry-gated item (see probeMacBackend). Windows does not
// use this: there the Hello prompt itself produces the key (getWindowsHelloKey)
export async function authenticateWithBiometrics(data: { dbPath: string, dbName: string }): Promise<boolean> {
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
        console.info('Biometric backend: prompt (Touch ID addon unavailable)');
        return 'gate';
    }
    const written = await touchid.setSecret(ENTITLEMENT_PROBE_ACCOUNT, randomBytes(32));
    if (!written.ok) {
        console.info(`Biometric backend: prompt (keychain rejected the probe: ${written.code})`);
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
    if (!readBack.ok || !readBack.data.equals(wrappingKey)) {
        await touchid.deleteSecret(account);
        if (readBack.code === 'canceled') {
            return { error: 'Biometric authentication was cancelled' };
        }
        // Anything else means the round trip is not trustworthy on this
        // machine; let the caller fall back rather than storing a blob only
        // a broken keychain item can open
        console.error('Touch ID keychain read-back failed:', readBack.code, readBack.status ?? '');
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

// macOS only (legacy scheme; see authenticateWithBiometrics)
async function getHardwareId(): Promise<string> {
    try {
        const hardwareUUID = execSync('system_profiler SPHardwareDataType | grep "Hardware UUID"').toString().split(':')[1].trim();
        return hardwareUUID;
    } catch (error) {
        console.error('Failed to get hardware ID:', error);
        return `${process.env.USER}-${execSync('hostname').toString().trim()}`;
    }
}

async function deriveEncryptionKey(hardwareId: string, salt: string): Promise<Buffer> {
    return pbkdf2Sync(hardwareId, salt, 100000, 32, 'sha512');
}

async function encryptPassword(password: string): Promise<string> {
    const hardwareId = await getHardwareId();
    const salt = await getInstallationSalt();
    const key = await deriveEncryptionKey(hardwareId, salt);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
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

export async function hasBiometricsEnabled(dbPath: string): Promise<{ success: boolean, error?: string, enabled?: boolean }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);
        const hasPassword = await keytar?.getPassword(SERVICE_NAME, key);
        return { success: true, enabled: !!hasPassword };
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

        const dbName = dbPath.split('/').pop() as string;

        if (process.platform === 'darwin' && await getMacBackend() === 'secure') {
            const sealed = await enableSecureMac(key, dbName);
            if (sealed && 'error' in sealed) return { success: false, error: sealed.error };
            if (sealed) {
                await keytar?.setPassword(SERVICE_NAME, key, sealWithKeychainKey(password, sealed.wrappingKey));
                return { success: true };
            }
            // null means the keychain round trip did not work here; fall
            // through to the prompt-only scheme rather than losing the feature
        }

        if (!await authenticateWithBiometrics({ dbPath, dbName })) {
            return { success: false, error: 'Biometric authentication failed' };
        }

        const encryptedPassword = await encryptPassword(password);
        await keytar?.setPassword(SERVICE_NAME, key, encryptedPassword);
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

        if (!await authenticateWithBiometrics({ dbPath, dbName })) {
            return { success: false, error: 'Biometric authentication failed', retry: true };
        }

        const password = await decryptPassword(stored);

        // Legacy blob on a build that can do the real thing: re-seal it now so
        // the next unlock is enforced by the keychain instead of the prompt.
        // Best effort, an unlock must not fail because the upgrade did
        if (process.platform === 'darwin' && await getMacBackend() === 'secure') {
            try {
                const wrappingKey = randomBytes(32);
                const written = await touchid.setSecret(key, wrappingKey);
                if (written.ok) {
                    await keytar?.setPassword(SERVICE_NAME, key, sealWithKeychainKey(password, wrappingKey));
                }
            } catch (error) {
                console.error('Failed to upgrade biometric storage:', error);
            }
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

// What is actually protecting the stored password, so the UI can say so
// rather than showing the same "biometric unlock" affordance for two very
// different guarantees
export type BiometricsBackend = 'hardware' | 'prompt' | 'none';

export async function getBiometricsInfo(): Promise<{
    available: boolean,
    backend: BiometricsBackend,
    biometryType: string
}> {
    const available = await isBiometricsAvailable();
    if (!available) return { available: false, backend: 'none', biometryType: 'none' };

    if (process.platform === 'win32') {
        return { available: true, backend: 'hardware', biometryType: 'windows-hello' };
    }

    if (process.platform === 'darwin') {
        const backend = await getMacBackend();
        return {
            available: true,
            backend: backend === 'secure' ? 'hardware' : 'prompt',
            biometryType: touchid.availability().biometryType,
        };
    }

    return { available, backend: 'none', biometryType: 'none' };
}

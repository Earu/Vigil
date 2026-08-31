import { systemPreferences } from 'electron';
import { execSync } from 'child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import keytar from './get-keytar';
import {
    isV2Blob,
    makeChallenge,
    deriveKeyFromSignature,
    sealPassword,
    challengeFromBlob,
    openPassword
} from './biometrics-crypto';

let Passport: any;
if (process.platform === 'win32') {
    const { Passport: WindowsPassport } = require('passport-desktop');
    Passport = WindowsPassport;
}

const SERVICE_NAME = 'Vigil Password Manager';
const SALT_PATH = path.join(app.getPath('userData'), '.salt');

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

// macOS only: gates access with a Touch ID prompt. This is a UI gate, not a
// cryptographic one; binding the key to the Secure Enclave needs native code
// and is tracked as a follow-up. Windows does not use this: there the Hello
// prompt itself produces the key (see getWindowsHelloKey)
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

        if (!await authenticateWithBiometrics({ dbPath, dbName: dbPath.split('/').pop() as string })) {
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

export async function getBiometricPassword(dbPath: string): Promise<{ success: boolean, error?: string, password?: string }> {
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
                return { success: false, error: 'Biometric authentication failed' };
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

        if (!await authenticateWithBiometrics({ dbPath, dbName: dbPath.split('/').pop() as string })) {
            return { success: false, error: 'Biometric authentication failed' };
        }

        const password = await decryptPassword(stored);
        return { success: true, password };
    } catch (error) {
        console.error('Failed to get password with biometrics:', error);
        return { success: false, error: 'Failed to authenticate with biometrics' };
    }
}

export async function disableBiometrics(dbPath: string): Promise<{ success: boolean, error?: string }> {
    try {
        const key = await generateUniqueKey(dbPath);
        await keytar?.deletePassword(SERVICE_NAME, key);
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
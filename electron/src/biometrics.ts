import { systemPreferences } from 'electron';
import { execSync } from 'child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import keytar from './get-keytar';

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

export async function authenticateWithBiometrics(data: { dbPath: string, dbName: string }): Promise<boolean> {
    if (process.platform === 'darwin') {
        try {
            await systemPreferences.promptTouchID(`unlock ${data.dbName} with biometrics`);
            return true;
        } catch (error) {
            console.error('TouchID authentication failed:', error);
            return false;
        }
    } else if (process.platform === 'win32') {
        try {
            const passport = new Passport(data.dbPath);
            if (!passport.accountExists) {
                await passport.createAccount();
                return true;
            }

            const result = await Passport.requestVerification(`Unlock ${data.dbName} with Windows Hello`);
            return result === 0;
        } catch (error) {
            console.error('Windows Hello authentication failed:', error);
            return false;
        }
    }
    return false;
}

async function getHardwareId(): Promise<string> {
    if (process.platform === 'win32') {
        try {
            const mbSerial = execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim();
            const cpuId = execSync('wmic cpu get processorid').toString().split('\n')[1].trim();
            return `${mbSerial}-${cpuId}`;
        } catch (error) {
            console.error('Failed to get hardware ID:', error);
            return `${process.env.USERNAME}-${process.env.COMPUTERNAME}`;
        }
    } else if (process.platform === 'darwin') {
        try {
            const hardwareUUID = execSync('system_profiler SPHardwareDataType | grep "Hardware UUID"').toString().split(':')[1].trim();
            return hardwareUUID;
        } catch (error) {
            console.error('Failed to get hardware ID:', error);
            return `${process.env.USER}-${execSync('hostname').toString().trim()}`;
        }
    } else {
        try {
            const mbSerial = execSync('sudo dmidecode -s baseboard-serial-number').toString().trim();
            return mbSerial;
        } catch (error) {
            console.error('Failed to get hardware ID:', error);
            try {
                return fs.readFileSync('/etc/machine-id', 'utf8').trim();
            } catch {
                return `${process.env.USER}-${execSync('hostname').toString().trim()}`;
            }
        }
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

        if (!await authenticateWithBiometrics({ dbPath, dbName: dbPath.split('/').pop() as string })) {
            return { success: false, error: 'Biometric authentication failed' };
        }

        const key = await generateUniqueKey(dbPath);
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

        if (!await authenticateWithBiometrics({ dbPath, dbName: dbPath.split('/').pop() as string })) {
            return { success: false, error: 'Biometric authentication failed' };
        }

        const key = await generateUniqueKey(dbPath);
        const encryptedPassword = await keytar?.getPassword(SERVICE_NAME, key);
        if (!encryptedPassword) {
            return { success: false, error: 'No password found for this database' };
        }

        const password = await decryptPassword(encryptedPassword);
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
        return { success: true };
    } catch (error) {
        console.error('Failed to disable biometrics:', error);
        return { success: false, error: 'Failed to disable biometric authentication' };
    }
}
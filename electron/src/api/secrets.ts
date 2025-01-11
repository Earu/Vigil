import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';
import { getInstallationSalt } from '../biometrics';
import { Secret } from './types';

// 24 hours in milliseconds
const SECRET_VALIDITY_DURATION = 24 * 60 * 60 * 1000;

async function deriveSecretKey(salt: string): Promise<Buffer> {
    // Use a constant string as the base for the key derivation
    const base = 'vigil-extension-secret';
    return pbkdf2Sync(base, salt, 100000, 32, 'sha512');
}

export async function generateSecret(appName: string, dbPath: string): Promise<string> {
    const salt = await getInstallationSalt();
    const key = await deriveSecretKey(salt);
    const iv = Buffer.alloc(16, 0);

    const secret: Secret = {
        timeCreated: Date.now(),
        appName,
        dbPath
    };

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(secret), 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export async function validateSecret(secret: string, dbPath: string): Promise<{ valid: boolean, appName?: string }> {
    try {
        const salt = await getInstallationSalt();
        const key = await deriveSecretKey(salt);
        const data = Buffer.from(secret, 'base64');

        const iv = data.subarray(0, 16);
        const authTag = data.subarray(16, 32);
        const encrypted = data.subarray(32);

        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        const decrypted = JSON.parse(
            decipher.update(encrypted) + decipher.final('utf8')
        ) as Secret;

        const now = Date.now();
        if (now - decrypted.timeCreated > SECRET_VALIDITY_DURATION) {
            return { valid: false };
        }

        if (decrypted.dbPath !== dbPath) {
            return { valid: false };
        }

        return { valid: true, appName: decrypted.appName };
    } catch (error) {
        console.error('Error validating secret:', error);
        return { valid: false };
    }
}
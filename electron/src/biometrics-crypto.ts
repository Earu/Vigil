import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

// Sealing for biometric-protected master passwords (v2, Windows).
// The AES key is derived from a Windows Hello signature over a random
// challenge stored alongside the ciphertext. The signature is RSA
// PKCS#1 v1.5, so it is deterministic and re-derivable, but producing it
// requires a live Hello verification: the key never exists on disk.
// (Same construction as Bitwarden's Windows Hello unlock.)

const V2_PREFIX = 'v2:';
const CHALLENGE_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export function isV2Blob(blob: string): boolean {
    return blob.startsWith(V2_PREFIX);
}

export function makeChallenge(): Buffer {
    return randomBytes(CHALLENGE_LENGTH);
}

export function deriveKeyFromSignature(signature: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', signature, Buffer.alloc(0), 'vigil-biometric-v2', 32));
}

export function sealPassword(password: string, challenge: Buffer, key: Buffer): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return V2_PREFIX + Buffer.concat([challenge, iv, tag, encrypted]).toString('base64');
}

export function challengeFromBlob(blob: string): Buffer {
    const data = Buffer.from(blob.slice(V2_PREFIX.length), 'base64');
    if (data.length < CHALLENGE_LENGTH + IV_LENGTH + TAG_LENGTH) {
        throw new Error('Malformed biometric blob');
    }
    return data.subarray(0, CHALLENGE_LENGTH);
}

export function openPassword(blob: string, key: Buffer): string {
    const data = Buffer.from(blob.slice(V2_PREFIX.length), 'base64');
    if (data.length < CHALLENGE_LENGTH + IV_LENGTH + TAG_LENGTH) {
        throw new Error('Malformed biometric blob');
    }
    const iv = data.subarray(CHALLENGE_LENGTH, CHALLENGE_LENGTH + IV_LENGTH);
    const tag = data.subarray(CHALLENGE_LENGTH + IV_LENGTH, CHALLENGE_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(CHALLENGE_LENGTH + IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

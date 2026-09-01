import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

// Sealing for biometric-protected master passwords.
//
// v2 (Windows): the AES key is derived from a Windows Hello signature over a
// random challenge stored alongside the ciphertext. The signature is RSA
// PKCS#1 v1.5, so it is deterministic and re-derivable, but producing it
// requires a live Hello verification: the key never exists on disk.
// (Same construction as Bitwarden's Windows Hello unlock.)
//
// v3 (macOS): the AES key is derived from a random 32-byte value that lives
// in a biometry-gated keychain item, so releasing it costs a Touch ID (or
// device passcode) check enforced by the OS. Nothing on disk derives the key.
// Same shape as v2 minus the challenge, because the wrapping key is stored
// rather than reconstructed. (KeePassXC's TouchID quick unlock does the same
// thing, with the sealed key held in memory instead of the keychain.)

const V2_PREFIX = 'v2:';
const V3_PREFIX = 'v3:';
const CHALLENGE_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export function isV2Blob(blob: string): boolean {
    return blob.startsWith(V2_PREFIX);
}

export function isV3Blob(blob: string): boolean {
    return blob.startsWith(V3_PREFIX);
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

// v3: seal under a key that only a passed biometric check can produce.
// The keychain value is run through HKDF rather than used directly, so the
// AES key is domain separated from whatever else that secret might gate
export function sealWithKeychainKey(password: string, keychainKey: Buffer): string {
    const key = Buffer.from(hkdfSync('sha256', keychainKey, Buffer.alloc(0), 'vigil-biometric-v3', 32));
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return V3_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function openWithKeychainKey(blob: string, keychainKey: Buffer): string {
    const data = Buffer.from(blob.slice(V3_PREFIX.length), 'base64');
    if (data.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error('Malformed biometric blob');
    }
    const key = Buffer.from(hkdfSync('sha256', keychainKey, Buffer.alloc(0), 'vigil-biometric-v3', 32));
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

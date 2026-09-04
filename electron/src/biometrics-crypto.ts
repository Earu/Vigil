import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

// Sealing for biometric-protected master passwords.
//
// Exactly one live format per platform; a blob in any older format is
// discarded at read and the user re-enables. These are convenience secrets
// (a sealed copy of a password the user knows), so "migration" for them is
// a reset, not a compatibility reader that lives forever.
//
// v3 (macOS): the AES key is derived from a random 32-byte value that lives
// in a biometry-gated keychain item, so releasing it costs a Touch ID (or
// device passcode) check enforced by the OS. Nothing on disk derives the key.
// Same envelope as v4 minus the challenge, because the wrapping key is
// stored rather than reconstructed. (KeePassXC's TouchID quick unlock does the same
// thing, with the sealed key held in memory instead of the keychain.)
//
// session (Windows, "require master password after restart"): the same
// envelope as v4, held in process memory only, never written anywhere. The
// HKDF salt is a random value kept beside the ciphertext in memory and the
// key is the Hello signature over the challenge, so reading this process's
// memory (a debugger, a crash dump, swap) yields ciphertext and a challenge:
// releasing the password still takes a live Hello signature, and a restart
// takes even that away. This is KeePassXC's Windows Hello quick-unlock model.
//
// v4 (Windows): the AES key is HKDF of a Windows Hello signature over a
// random challenge stored alongside the ciphertext, with a DPAPI-protected
// random entropy value as the salt. The RSA PKCS#1 v1.5 signature is
// deterministic and re-derivable, but producing it requires a live Hello
// verification: the key never exists on disk. The entropy means the
// signature alone no longer derives the key either. Against
// same-user malware phishing a Hello prompt this only adds one more store to
// read; what it actually closes is every path that reaches the Credential
// Manager blob without user-context code execution (credential roaming,
// backup exfiltration, cross-user reads). The real defense against prompt
// phishing is the session-scoped mode in biometrics.ts, which writes no
// persistent blob at all.

const V3_PREFIX = 'v3:';
const V4_PREFIX = 'v4:';
const SESSION_PREFIX = 'session:';
const CHALLENGE_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export function isV3Blob(blob: string): boolean {
    return blob.startsWith(V3_PREFIX);
}

export function isV4Blob(blob: string): boolean {
    return blob.startsWith(V4_PREFIX);
}

export function makeChallenge(): Buffer {
    return randomBytes(CHALLENGE_LENGTH);
}

// v4: the entropy is the HKDF salt, so the same signature under different
// entropy derives unrelated keys, and neither input alone derives anything
export function deriveKeyWithEntropy(signature: Buffer, entropy: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', signature, entropy, 'vigil-biometric-v4', 32));
}

function sealWithPrefix(prefix: string, password: string, challenge: Buffer, key: Buffer): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return prefix + Buffer.concat([challenge, iv, tag, encrypted]).toString('base64');
}

function challengeWithPrefix(prefix: string, blob: string): Buffer {
    const data = Buffer.from(blob.slice(prefix.length), 'base64');
    if (data.length < CHALLENGE_LENGTH + IV_LENGTH + TAG_LENGTH) {
        throw new Error('Malformed biometric blob');
    }
    return data.subarray(0, CHALLENGE_LENGTH);
}

function openWithPrefix(prefix: string, blob: string, key: Buffer): string {
    const data = Buffer.from(blob.slice(prefix.length), 'base64');
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

export function sealPasswordV4(password: string, challenge: Buffer, key: Buffer): string {
    return sealWithPrefix(V4_PREFIX, password, challenge, key);
}

export function challengeFromV4Blob(blob: string): Buffer {
    return challengeWithPrefix(V4_PREFIX, blob);
}

export function openPasswordV4(blob: string, key: Buffer): string {
    return openWithPrefix(V4_PREFIX, blob, key);
}

// session: the salt is random per arming and lives only in memory, so the
// signature alone (deterministic, re-derivable after any Hello prompt)
// derives nothing without it, and the sealed copy dies with the process
export function deriveSessionKey(signature: Buffer, salt: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', signature, salt, 'vigil-biometric-session', 32));
}

export function sealPasswordSession(password: string, challenge: Buffer, key: Buffer): string {
    return sealWithPrefix(SESSION_PREFIX, password, challenge, key);
}

export function challengeFromSessionBlob(blob: string): Buffer {
    return challengeWithPrefix(SESSION_PREFIX, blob);
}

export function openPasswordSession(blob: string, key: Buffer): string {
    return openWithPrefix(SESSION_PREFIX, blob, key);
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

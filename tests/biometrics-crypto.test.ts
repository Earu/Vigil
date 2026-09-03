import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import {
    isV3Blob,
    makeChallenge,
    sealWithKeychainKey,
    openWithKeychainKey,
    isV4Blob,
    deriveKeyWithEntropy,
    sealPasswordV4,
    challengeFromV4Blob,
    openPasswordV4,
} from '../electron/src/biometrics-crypto';

describe('biometrics sealing (v3, Touch ID keychain)', () => {
    it('round-trips a password under the keychain key', () => {
        const keychainKey = randomBytes(32);
        const blob = sealWithKeychainKey('correct horse battery staple', keychainKey);

        expect(isV3Blob(blob)).toBe(true);
        expect(openWithKeychainKey(blob, keychainKey)).toBe('correct horse battery staple');
    });

    it('rejects a wrong key (the keychain item was replaced)', () => {
        const blob = sealWithKeychainKey('pw', randomBytes(32));
        expect(() => openWithKeychainKey(blob, randomBytes(32))).toThrow();
    });

    it('rejects a tampered blob rather than returning garbage', () => {
        const keychainKey = randomBytes(32);
        const blob = sealWithKeychainKey('pw', keychainKey);
        const raw = Buffer.from(blob.slice(3), 'base64');
        raw[raw.length - 1] ^= 0xff;
        expect(() => openWithKeychainKey('v3:' + raw.toString('base64'), keychainKey)).toThrow();
    });

    it('rejects a truncated blob', () => {
        expect(() => openWithKeychainKey('v3:' + randomBytes(8).toString('base64'), randomBytes(32)))
            .toThrow('Malformed biometric blob');
    });

    it('uses a fresh IV per seal, so the same password never repeats a blob', () => {
        const keychainKey = randomBytes(32);
        expect(sealWithKeychainKey('pw', keychainKey)).not.toBe(sealWithKeychainKey('pw', keychainKey));
    });

    // The two schemes are told apart by prefix alone, and a blob must never
    // be handed to the other platform's opener
    it('keeps the two blob formats distinguishable', () => {
        const v4 = sealPasswordV4('pw', makeChallenge(), deriveKeyWithEntropy(randomBytes(256), randomBytes(32)));
        expect(isV3Blob(v4)).toBe(false);
        expect(isV4Blob(sealWithKeychainKey('pw', randomBytes(32)))).toBe(false);
    });
});

describe('biometrics sealing (v4, Hello signature + DPAPI entropy)', () => {
    it('round-trips a password', () => {
        const challenge = makeChallenge();
        const key = deriveKeyWithEntropy(randomBytes(256), randomBytes(32));
        const blob = sealPasswordV4('correct horse battery staple', challenge, key);

        expect(isV4Blob(blob)).toBe(true);
        expect(challengeFromV4Blob(blob).equals(challenge)).toBe(true);
        expect(openPasswordV4(blob, key)).toBe('correct horse battery staple');
    });

    it('neither input alone derives the key', () => {
        const signature = randomBytes(256);
        const entropy = randomBytes(32);
        const key = deriveKeyWithEntropy(signature, entropy);

        // Same signature, different entropy: unrelated key (this is what the
        // DPAPI half buys over v2)
        expect(key.equals(deriveKeyWithEntropy(signature, randomBytes(32)))).toBe(false);
        // Same entropy, different signature: unrelated key
        expect(key.equals(deriveKeyWithEntropy(randomBytes(256), entropy))).toBe(false);
        // Both inputs equal: deterministic
        expect(key.equals(deriveKeyWithEntropy(Buffer.from(signature), Buffer.from(entropy)))).toBe(true);
    });

    it('rejects a wrong key', () => {
        const blob = sealPasswordV4('pw', makeChallenge(), deriveKeyWithEntropy(randomBytes(256), randomBytes(32)));
        expect(() => openPasswordV4(blob, deriveKeyWithEntropy(randomBytes(256), randomBytes(32)))).toThrow();
    });
});

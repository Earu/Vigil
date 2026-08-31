import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import {
    isV2Blob,
    makeChallenge,
    deriveKeyFromSignature,
    sealPassword,
    challengeFromBlob,
    openPassword,
} from '../electron/src/biometrics-crypto';

describe('biometrics sealing (v2)', () => {
    it('round-trips a password', () => {
        const challenge = makeChallenge();
        const key = deriveKeyFromSignature(randomBytes(256));
        const blob = sealPassword('correct horse battery staple', challenge, key);

        expect(isV2Blob(blob)).toBe(true);
        expect(openPassword(blob, key)).toBe('correct horse battery staple');
    });

    it('stores the challenge in the blob so unlock can re-sign it', () => {
        const challenge = makeChallenge();
        const key = deriveKeyFromSignature(randomBytes(256));
        const blob = sealPassword('pw', challenge, key);
        expect(challengeFromBlob(blob).equals(challenge)).toBe(true);
    });

    it('derives the same key from the same signature (deterministic RSA sig)', () => {
        const signature = randomBytes(256);
        const a = deriveKeyFromSignature(signature);
        const b = deriveKeyFromSignature(Buffer.from(signature));
        expect(a.equals(b)).toBe(true);
        expect(a.length).toBe(32);
        expect(a.equals(deriveKeyFromSignature(randomBytes(256)))).toBe(false);
    });

    it('rejects a wrong key (Hello key was reset)', () => {
        const blob = sealPassword('pw', makeChallenge(), deriveKeyFromSignature(randomBytes(256)));
        const wrongKey = deriveKeyFromSignature(randomBytes(256));
        expect(() => openPassword(blob, wrongKey)).toThrow();
    });

    it('rejects a tampered blob', () => {
        const key = deriveKeyFromSignature(randomBytes(256));
        const blob = sealPassword('pw', makeChallenge(), key);
        const data = Buffer.from(blob.slice(3), 'base64');
        data[data.length - 1] ^= 0xff; // flip a ciphertext bit
        expect(() => openPassword('v2:' + data.toString('base64'), key)).toThrow();
    });

    it('does not mistake legacy blobs for v2', () => {
        // old format: base64(iv | tag | ciphertext), no prefix
        const legacy = randomBytes(48).toString('base64');
        expect(isV2Blob(legacy)).toBe(false);
    });

    it('rejects truncated blobs instead of misreading them', () => {
        expect(() => challengeFromBlob('v2:' + randomBytes(10).toString('base64'))).toThrow();
        const key = deriveKeyFromSignature(randomBytes(256));
        expect(() => openPassword('v2:' + randomBytes(10).toString('base64'), key)).toThrow();
    });
});

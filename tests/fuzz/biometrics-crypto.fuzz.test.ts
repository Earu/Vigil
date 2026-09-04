import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { randomBytes } from 'crypto';
import {
    makeChallenge,
    deriveKeyWithEntropy,
    sealPasswordV4,
    challengeFromV4Blob,
    openPasswordV4,
    sealWithKeychainKey,
    openWithKeychainKey,
} from '../../electron/src/biometrics-crypto';
import { settings, anyText, bytes } from './fuzz';

// The sealed master password sits in the OS credential store. Whatever a
// blob looks like, opening it must either yield exactly what was sealed
// under the right key, or throw; it may never return something under a
// wrong key or for a blob nobody sealed

const key32 = () => fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => Buffer.from(b));
const password = () => fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.string({ minLength: 200, maxLength: 400 }));

describe('biometric sealing under fuzz', () => {
    it('v4 round-trips any password under its own key and refuses every other key', () => {
        fc.assert(fc.property(password(), key32(), key32(), (secret, key, other) => {
            fc.pre(!key.equals(other));
            const challenge = makeChallenge();
            const blob = sealPasswordV4(secret, challenge, key);
            expect(challengeFromV4Blob(blob).equals(challenge)).toBe(true);
            expect(openPasswordV4(blob, key)).toBe(secret);
            expect(() => openPasswordV4(blob, other)).toThrow();
        }), settings());
    });

    it('v3 round-trips any password under its own key and refuses every other key', () => {
        fc.assert(fc.property(password(), key32(), key32(), (secret, key, other) => {
            fc.pre(!key.equals(other));
            const blob = sealWithKeychainKey(secret, key);
            expect(openWithKeychainKey(blob, key)).toBe(secret);
            expect(() => openWithKeychainKey(blob, other)).toThrow();
        }), settings());
    });

    it('a blob nobody sealed always throws, whatever it contains', () => {
        const key = randomBytes(32);
        const blob = fc.oneof(
            anyText(),
            bytes(300).map(b => 'v4:' + Buffer.from(b).toString('base64')),
            bytes(300).map(b => 'v3:' + Buffer.from(b).toString('base64')),
        );
        fc.assert(fc.property(blob, (text) => {
            expect(() => openPasswordV4(text, key)).toThrow();
            expect(() => openWithKeychainKey(text, key)).toThrow();
        }), settings());
    });

    it('any single-byte change to the sealed part of a blob is refused', () => {
        // The first 32 bytes are the challenge, which is not under the tag:
        // it is bound by being the input to the key derivation instead, so a
        // changed challenge produces a different key, covered above
        const key = randomBytes(32);
        const sealed = Buffer.from(sealPasswordV4('correct horse', makeChallenge(), key).slice(3), 'base64');
        fc.assert(fc.property(fc.integer({ min: 32, max: sealed.length - 1 }), fc.integer({ min: 1, max: 255 }), (index, delta) => {
            const tampered = Buffer.from(sealed);
            tampered[index] = (tampered[index] + delta) & 0xff;
            expect(() => openPasswordV4('v4:' + tampered.toString('base64'), key)).toThrow();
        }), settings());
    });

    it('the entropy salt separates keys: the same signature under different entropy never opens', () => {
        fc.assert(fc.property(bytes(256), key32(), key32(), (signature, entropyA, entropyB) => {
            fc.pre(!entropyA.equals(entropyB));
            const sig = Buffer.from(signature);
            const a = deriveKeyWithEntropy(sig, entropyA);
            const b = deriveKeyWithEntropy(sig, entropyB);
            expect(a.equals(b)).toBe(false);
            const blob = sealPasswordV4('secret', makeChallenge(), a);
            expect(() => openPasswordV4(blob, b)).toThrow();
        }), settings());
    });
});

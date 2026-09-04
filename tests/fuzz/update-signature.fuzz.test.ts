import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSync, sign } from 'crypto';
import { parsePublicKey, verifyUpdateMetadata } from '../../electron/src/update-signature';
import { settings, anyText, anyValue, bytes } from './fuzz';

// The update verifier is the one function standing between a compromised
// GitHub account and code execution on every install. Nothing it is handed
// may make it say ok without the release key, and nothing may make it throw
// instead of answering

const METADATA = `version: 1.5.0
files:
  - url: vigil-linux-x64-v1.5.0.AppImage
    sha512: abc
path: vigil-linux-x64-v1.5.0.AppImage
sha512: abc
`;
const expected = { version: '1.5.0', files: [{ url: 'https://github.com/x/y/releases/download/v1.5.0/vigil-linux-x64-v1.5.0.AppImage', sha512: 'abc' }] };

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const key = parsePublicKey(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
const metadata = Buffer.from(METADATA);
const goodSignature = sign(null, metadata, privateKey).toString('base64');

describe('update signature verifier under fuzz', () => {
    it('never accepts random signatures, and never throws on them', () => {
        fc.assert(fc.property(fc.oneof(anyText(), bytes(200).map(b => Buffer.from(b).toString('base64'))), (signature) => {
            const result = verifyUpdateMetadata(metadata, signature, key, expected);
            expect(result.ok).toBe(false);
        }), settings());
    });

    it('any change to signed metadata is refused', () => {
        fc.assert(fc.property(fc.nat({ max: metadata.length - 1 }), fc.integer({ min: 1, max: 255 }), (index, delta) => {
            const tampered = Buffer.from(metadata);
            tampered[index] = (tampered[index] + delta) & 0xff;
            expect(verifyUpdateMetadata(tampered, goodSignature, key, expected).ok).toBe(false);
        }), settings());
    });

    it('any change to the signature is refused', () => {
        const raw = Buffer.from(goodSignature, 'base64');
        fc.assert(fc.property(fc.nat({ max: raw.length - 1 }), fc.integer({ min: 1, max: 255 }), (index, delta) => {
            const tampered = Buffer.from(raw);
            tampered[index] = (tampered[index] + delta) & 0xff;
            expect(verifyUpdateMetadata(metadata, tampered.toString('base64'), key, expected).ok).toBe(false);
        }), settings());
    });

    it('a digest or version the signed document does not vouch for is refused', () => {
        fc.assert(fc.property(anyText(), anyText(), (version, sha512) => {
            fc.pre(version !== expected.version || sha512 !== 'abc');
            const result = verifyUpdateMetadata(metadata, goodSignature, key, {
                version,
                files: [{ url: expected.files[0].url, sha512 }],
            });
            expect(result.ok).toBe(false);
        }), settings());
    });

    it('answers rather than throws for any metadata bytes and any expectation shape', () => {
        fc.assert(fc.property(bytes(600), anyValue(), (bytesIn, shape) => {
            const result = verifyUpdateMetadata(bytesIn, goodSignature, key, shape as any);
            expect(typeof result.ok).toBe('boolean');
            expect(result.ok).toBe(false);
        }), settings());
    });
});

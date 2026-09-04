import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import { parsePrivateKey, readPublicInfo, looksLikePrivateKey, publicBlobOf, SshKeyError, WireReader, wireString } from '../../electron/src/ssh-key';
import { settings, anyText, bytes } from './fuzz';

// The key parser reads attachment bytes straight out of a vault, which may
// have been written by anything. Whatever it is handed, it must answer with
// an SshKeyError or a key, never a crash or a hang, and a wrong passphrase
// must never yield a key.

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ssh');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const OPENSSH = fixture('ed25519_enc');
const PEM = fixture('rsa_pem');
const PASSPHRASE = 'correct horse';

const onlySshKeyErrors = (work: () => unknown) => {
    try {
        work();
    } catch (error) {
        expect(error).toBeInstanceOf(SshKeyError);
    }
};

describe('private key parsing under fuzz', () => {
    it('answers arbitrary bytes and text with a key or an SshKeyError', () => {
        fc.assert(fc.property(fc.oneof(bytes(2048), anyText().map(t => new TextEncoder().encode(t))), anyText(), (data, passphrase) => {
            onlySshKeyErrors(() => parsePrivateKey(data, passphrase));
            onlySshKeyErrors(() => readPublicInfo(data));
            onlySshKeyErrors(() => publicBlobOf(data, passphrase));
            expect(typeof looksLikePrivateKey(data)).toBe('boolean');
        }), settings());
    });

    it('survives a real key with bytes flipped, truncated or inserted', () => {
        const mutate = fc.tuple(fc.constantFrom(OPENSSH, PEM), fc.array(fc.tuple(fc.nat(2000), fc.nat(255)), { maxLength: 8 }), fc.nat(2000))
            .map(([base, flips, cut]) => {
                const out = new Uint8Array(base.subarray(0, Math.max(1, Math.min(base.length, cut + 1))));
                for (const [at, value] of flips) if (at < out.length) out[at] = value;
                return out;
            });
        fc.assert(fc.property(mutate, fc.constantFrom('', PASSPHRASE, 'wrong'), (data, passphrase) => {
            onlySshKeyErrors(() => parsePrivateKey(data, passphrase));
            onlySshKeyErrors(() => readPublicInfo(data));
        }), settings());
    });

    it('never opens an encrypted key with anything but its passphrase', () => {
        fc.assert(fc.property(anyText().filter(t => t !== PASSPHRASE), (passphrase) => {
            expect(() => parsePrivateKey(OPENSSH, passphrase)).toThrow(SshKeyError);
        }), settings({ numRuns: 40 }));
    });

    it('wire helpers round trip any byte string', () => {
        fc.assert(fc.property(bytes(256), (data) => {
            const reader = new WireReader(wireString(Buffer.from(data)));
            expect(Buffer.from(reader.string())).toEqual(Buffer.from(data));
            expect(reader.remaining).toBe(0);
        }), settings());
    });
});

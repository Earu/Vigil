import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createPublicKey, createSign, createVerify, sign as signOneShot, verify as verifyOneShot, KeyObject } from 'crypto';
import { parsePrivateKey, readPublicInfo, looksLikePrivateKey, SshKeyError, WireReader, wireMpint, wireString } from '../electron/src/ssh-key';

// Every fixture was written by ssh-keygen (see the manifest for the
// fingerprints it printed). The parser has to reach the same public blob
// for each of them, and produce private parts that actually sign.

const FIXTURES = path.join(__dirname, 'fixtures', 'ssh');
const PASSPHRASE = 'correct horse';
const manifest: Record<string, { type: string; fingerprint: string; publicBase64: string; comment: string }> =
    JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));

const load = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

// The private parts must be the key ssh-keygen wrote: rebuild a Node key
// from them and check a signature against the .pub file
function assertSigns(name: string, parts: Buffer, type: string): void {
    const pubPem = publicKeyFromManifest(name);
    const reader = new WireReader(parts);
    const message = Buffer.from('vigil ssh key test');
    if (type === 'ssh-ed25519') {
        reader.string();
        const sk = reader.string();
        const seed = sk.subarray(0, 32);
        // PKCS#8 wrapping of a raw ed25519 seed
        const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
        const signature = signOneShot(null, message, { key: pkcs8, format: 'der', type: 'pkcs8' });
        expect(verifyOneShot(null, message, pubPem, signature)).toBe(true);
        return;
    }
    if (type === 'ssh-rsa') {
        const [n, e, d, , p, q] = Array.from({ length: 6 }, () => reader.string());
        const jwk = {
            kty: 'RSA',
            n: unsignedB64(n), e: unsignedB64(e), d: unsignedB64(d), p: unsignedB64(p), q: unsignedB64(q),
            dp: unsignedB64(modBig(d, p)), dq: unsignedB64(modBig(d, q)), qi: unsignedB64(invMod(q, p)),
        };
        const signer = createSign('sha256').update(message);
        const signature = signer.sign({ key: jwk as any, format: 'jwk' });
        expect(createVerify('sha256').update(message).verify(pubPem, signature)).toBe(true);
        return;
    }
    if (type.startsWith('ecdsa-sha2-')) {
        reader.string();
        const point = reader.string();
        const d = reader.string();
        const size = (point.length - 1) / 2;
        const crv = { 32: 'P-256', 48: 'P-384', 66: 'P-521' }[size]!;
        const jwk = {
            kty: 'EC', crv,
            x: point.subarray(1, 1 + size).toString('base64url'),
            y: point.subarray(1 + size).toString('base64url'),
            d: leftPad(stripLeadingZero(d), size).toString('base64url'),
        };
        const signer = createSign('sha256').update(message);
        const signature = signer.sign({ key: jwk as any, format: 'jwk' });
        expect(createVerify('sha256').update(message).verify(pubPem, signature)).toBe(true);
        return;
    }
    throw new Error(`no signer for ${type}`);
}

const stripLeadingZero = (b: Buffer): Buffer => (b.length > 1 && b[0] === 0 ? b.subarray(1) : b);
const leftPad = (b: Buffer, n: number): Buffer => (b.length >= n ? b : Buffer.concat([Buffer.alloc(n - b.length), b]));
const unsignedB64 = (b: Buffer): string => stripLeadingZero(b).toString('base64url');
const toBig = (b: Buffer): bigint => BigInt('0x' + (stripLeadingZero(b).toString('hex') || '0'));
const fromBig = (v: bigint): Buffer => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
};
const modBig = (a: Buffer, m: Buffer): Buffer => fromBig(toBig(a) % (toBig(m) - 1n));
function invMod(a: Buffer, m: Buffer): Buffer {
    let [g, x, y] = [toBig(a), 1n, 0n];
    let mod = toBig(m);
    const M = mod;
    while (mod !== 0n) {
        const q = g / mod;
        [g, mod] = [mod, g - q * mod];
        [x, y] = [y, x - q * y];
    }
    return fromBig(((x % M) + M) % M);
}

// The public key ssh-keygen wrote, rebuilt from the .pub blob so the
// signature check is against the reference, never against what the parser
// itself produced
function publicKeyFromManifest(name: string): KeyObject {
    const blob = Buffer.from(manifest[name].publicBase64, 'base64');
    const reader = new WireReader(blob);
    const type = reader.text();
    if (type === 'ssh-ed25519') {
        const pk = reader.string();
        const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk]);
        return createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }
    if (type === 'ssh-rsa') {
        const e = reader.string();
        const n = reader.string();
        return createPublicKey({ key: { kty: 'RSA', n: unsignedB64(n), e: unsignedB64(e) } as any, format: 'jwk' });
    }
    const curve = reader.text();
    const point = reader.string();
    const size = (point.length - 1) / 2;
    const crv = { nistp256: 'P-256', nistp384: 'P-384', nistp521: 'P-521' }[curve]!;
    return createPublicKey({
        key: { kty: 'EC', crv, x: point.subarray(1, 1 + size).toString('base64url'), y: point.subarray(1 + size).toString('base64url') } as any,
        format: 'jwk',
    });
}

describe('private key parsing', () => {
    const cases: Array<[string, string]> = [
        ['ed25519_plain', ''],
        ['ed25519_enc', PASSPHRASE],
        ['ed25519_enc_default', PASSPHRASE],
        ['ed25519_gcm', PASSPHRASE],
        ['ed25519_cbc', PASSPHRASE],
        ['rsa_openssh', ''],
        ['rsa_pem', ''],
        ['rsa_pem_enc', PASSPHRASE],
        ['rsa_pkcs8', ''],
        ['ecdsa256_enc', PASSPHRASE],
        ['ecdsa384_pem', ''],
        ['ecdsa521_pkcs8_enc', PASSPHRASE],
        ['ed25519_pkcs8', ''],
    ];

    for (const [name, passphrase] of cases) {
        it(`reads ${name} to the public key ssh-keygen wrote, and the private half signs`, () => {
            const key = parsePrivateKey(load(name), passphrase);
            expect(key.type).toBe(manifest[name].type);
            expect(key.publicBlob.toString('base64')).toBe(manifest[name].publicBase64);
            expect(key.fingerprint).toBe(manifest[name].fingerprint);
            expect(key.encrypted).toBe(passphrase !== '');
            assertSigns(name, key.privateParts, key.type);
        });
    }

    it('keeps the comment from an OpenSSH file and has none for PEM', () => {
        expect(parsePrivateKey(load('ed25519_plain')).comment).toBe('vigil-test');
        expect(parsePrivateKey(load('ed25519_enc'), PASSPHRASE).comment).toBe('vigil-enc');
        expect(parsePrivateKey(load('rsa_pem')).comment).toBe('');
    });

    it('tells a missing passphrase from a wrong one', () => {
        for (const name of ['ed25519_enc', 'ed25519_gcm', 'rsa_pem_enc', 'ecdsa521_pkcs8_enc']) {
            expect(() => parsePrivateKey(load(name), '')).toThrow(expect.objectContaining({ code: 'passphrase' }));
            expect(() => parsePrivateKey(load(name), 'wrong')).toThrow(expect.objectContaining({ code: 'passphrase' }));
        }
    });

    it('refuses what it cannot handle with a reason rather than garbage', () => {
        expect(() => parsePrivateKey(load('ed25519_chacha'), PASSPHRASE)).toThrow(expect.objectContaining({ code: 'unsupported' }));
        expect(() => parsePrivateKey(Buffer.from('PuTTY-User-Key-File-3: ssh-ed25519\n'))).toThrow(expect.objectContaining({ code: 'unsupported' }));
        expect(() => parsePrivateKey(Buffer.from('hello'))).toThrow(SshKeyError);
        expect(() => parsePrivateKey(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n')))
            .toThrow(expect.objectContaining({ code: 'format' }));
        expect(() => parsePrivateKey(load('ed25519_plain.pub'))).toThrow(expect.objectContaining({ code: 'format' }));
    });

    it('refuses a KDF round count it cannot afford, at once', () => {
        // The bcrypt round count sits in the file's kdf options. One flipped
        // byte there (which the fuzz suite eventually produced) asks for
        // billions of rounds, and the parser would sit in the KDF for years
        const text = Buffer.from(load('ed25519_enc')).toString('latin1');
        const lines = text.split('\n');
        const raw = Buffer.from(lines.filter(l => l && !l.startsWith('-----')).join(''), 'base64');
        const reader = new WireReader(raw, 'openssh-key-v1\0'.length);
        reader.text(); reader.text(); // cipher, kdf
        // kdf options: string salt, u32 rounds
        const optionsStart = raw.length - reader.remaining + 4;
        const roundsAt = optionsStart + 4 + raw.readUInt32BE(optionsStart);
        expect(raw.readUInt32BE(roundsAt)).toBe(4);
        const withRounds = (rounds: number) => {
            const patched = Buffer.from(raw);
            patched.writeUInt32BE(rounds, roundsAt);
            const body = patched.toString('base64').match(/.{1,70}/g)!.join('\n');
            return Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`);
        };
        for (const rounds of [4227858436, 1025, 0]) {
            const start = performance.now();
            expect(() => parsePrivateKey(withRounds(rounds), PASSPHRASE)).toThrow(expect.objectContaining({ code: 'unsupported' }));
            expect(performance.now() - start).toBeLessThan(200);
        }
        // Rewritten with its real count, the file still opens
        expect(parsePrivateKey(withRounds(4), PASSPHRASE).type).toBe('ssh-ed25519');
    });

    it('reads the public half of an encrypted OpenSSH key without the passphrase', () => {
        const info = readPublicInfo(load('ed25519_enc'));
        expect(info).toEqual({ type: 'ssh-ed25519', fingerprint: manifest.ed25519_enc.fingerprint, comment: '', encrypted: true });
        const plain = readPublicInfo(load('ed25519_plain'));
        expect(plain).toEqual({ type: 'ssh-ed25519', fingerprint: manifest.ed25519_plain.fingerprint, comment: 'vigil-test', encrypted: false });
        // An encrypted PEM gives nothing away
        expect(readPublicInfo(load('rsa_pem_enc'))).toEqual({ type: '', fingerprint: '', comment: '', encrypted: true });
        expect(readPublicInfo(load('ecdsa384_pem')).fingerprint).toBe(manifest.ecdsa384_pem.fingerprint);
    });

    it('recognises key files by their header', () => {
        for (const name of ['ed25519_plain', 'rsa_pem', 'rsa_pem_enc', 'ecdsa521_pkcs8_enc', 'ed25519_pkcs8']) {
            expect(looksLikePrivateKey(load(name))).toBe(true);
        }
        expect(looksLikePrivateKey(load('rsa_pem.pub'))).toBe(false);
        expect(looksLikePrivateKey(Buffer.from([0, 1, 2, 3]))).toBe(false);
    });

    it('encodes mpints the way the agent reads them', () => {
        expect(wireMpint(Buffer.from([0x00, 0x00, 0x7f])).toString('hex')).toBe('000000017f');
        expect(wireMpint(Buffer.from([0x80])).toString('hex')).toBe('000000020080');
        expect(wireMpint(Buffer.from([0x00])).toString('hex')).toBe('00000000');
        expect(wireString('ab').toString('hex')).toBe('000000026162');
    });
});

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { channelFileName, parsePublicKey, releaseAssetUrl, verifyUpdateMetadata } from '../electron/src/update-signature';

// What electron-builder writes for a Windows release, verbatim in shape
const METADATA = `version: 1.5.0
files:
  - url: vigil-windows-x64-v1.5.0.exe
    sha512: AAAAsha512ofinstaller==
    size: 123456
path: vigil-windows-x64-v1.5.0.exe
sha512: AAAAsha512ofinstaller==
releaseDate: '2026-09-02T00:00:00.000Z'
`;

// What the GitHub provider hands the app for that same release
const found = {
    version: '1.5.0',
    files: [{ url: 'https://github.com/Earu/Vigil/releases/download/v1.5.0/vigil-windows-x64-v1.5.0.exe', sha512: 'AAAAsha512ofinstaller==' }],
};

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const signed = (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64');
const metadata = Buffer.from(METADATA);

describe('update metadata verification', () => {
    it('accepts metadata signed by the release key that names the found update', () => {
        expect(verifyUpdateMetadata(metadata, signed(METADATA), parsePublicKey(spki), found)).toEqual({ ok: true });
    });

    it('accepts the signature file as written, with its trailing newline', () => {
        expect(verifyUpdateMetadata(metadata, `${signed(METADATA)}\n`, parsePublicKey(spki), found).ok).toBe(true);
    });

    it('refuses metadata signed by another key', () => {
        const other = generateKeyPairSync('ed25519').privateKey;
        const forged = sign(null, metadata, other).toString('base64');
        const result = verifyUpdateMetadata(metadata, forged, parsePublicKey(spki), found);
        expect(result).toEqual({ ok: false, reason: 'signature does not match the metadata' });
    });

    it('refuses metadata altered after signing', () => {
        const altered = Buffer.from(METADATA.replace('1.5.0', '1.5.1'));
        expect(verifyUpdateMetadata(altered, signed(METADATA), parsePublicKey(spki), found).ok).toBe(false);
    });

    it('refuses garbage where the signature should be', () => {
        expect(verifyUpdateMetadata(metadata, 'not a signature', parsePublicKey(spki), found).ok).toBe(false);
        expect(verifyUpdateMetadata(metadata, '', parsePublicKey(spki), found).ok).toBe(false);
    });

    it('refuses a found update whose digest differs from the signed one', () => {
        // The attack this exists for: a swapped installer with a matching
        // unsigned latest.yml, so electron-updater's own digest check passes
        const swapped = { ...found, files: [{ ...found.files[0], sha512: 'BBBBdigestofmalware==' }] };
        const result = verifyUpdateMetadata(metadata, signed(METADATA), parsePublicKey(spki), swapped);
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toMatch(/different digest/);
    });

    it('refuses a found update for a version the signed metadata does not name', () => {
        const other = { ...found, version: '1.5.1' };
        expect(verifyUpdateMetadata(metadata, signed(METADATA), parsePublicKey(spki), other).ok).toBe(false);
    });

    it('refuses a file the signed metadata does not list', () => {
        const extra = { ...found, files: [...found.files, { url: 'https://example.com/other.exe', sha512: 'x' }] };
        const result = verifyUpdateMetadata(metadata, signed(METADATA), parsePublicKey(spki), extra);
        expect(result.ok ? '' : result.reason).toMatch(/not in the signed metadata/);
    });

    it('refuses an update that lists no files', () => {
        expect(verifyUpdateMetadata(metadata, signed(METADATA), parsePublicKey(spki), { ...found, files: [] }).ok).toBe(false);
    });

    it('matches files by asset name, as the provider rewrites spaces to dashes in URLs', () => {
        const yml = METADATA.replace(/vigil-windows-x64-v1.5.0.exe/g, 'Vigil Setup 1.5.0.exe');
        const spaced = { ...found, files: [{ ...found.files[0], url: 'https://github.com/Earu/Vigil/releases/download/v1.5.0/Vigil-Setup-1.5.0.exe' }] };
        // Dashes in the URL are not spaces in the yml: this is the case the
        // artifactName in electron-builder.config.js avoids by having no spaces
        expect(verifyUpdateMetadata(Buffer.from(yml), signed(yml), parsePublicKey(spki), spaced).ok).toBe(false);
        const encoded = { ...found, files: [{ ...found.files[0], url: 'https://github.com/Earu/Vigil/releases/download/v1.5.0/Vigil%20Setup%201.5.0.exe' }] };
        expect(verifyUpdateMetadata(Buffer.from(yml), signed(yml), parsePublicKey(spki), encoded).ok).toBe(true);
    });

    it('rejects a public key that is not ed25519', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
        const der = rsa.export({ format: 'der', type: 'spki' }).toString('base64');
        expect(() => parsePublicKey(der)).toThrow(/expected ed25519/);
    });
});

describe('release asset naming', () => {
    it('names the channel file the way electron-updater looks for it', () => {
        expect(channelFileName('win32', 'x64')).toBe('latest.yml');
        expect(channelFileName('darwin', 'arm64')).toBe('latest-mac.yml');
        expect(channelFileName('linux', 'x64')).toBe('latest-linux.yml');
        expect(channelFileName('linux', 'arm64')).toBe('latest-linux-arm64.yml');
    });

    it('builds the download URL for a release asset', () => {
        expect(releaseAssetUrl('Earu', 'Vigil', 'v1.5.0', 'latest.yml.sig'))
            .toBe('https://github.com/Earu/Vigil/releases/download/v1.5.0/latest.yml.sig');
    });
});

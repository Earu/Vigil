import { createPublicKey, verify, KeyObject } from 'crypto';
import { load, JSON_SCHEMA } from 'js-yaml';

// Authenticity of update metadata.
//
// electron-updater fetches latest*.yml from the GitHub release, reads the
// version and the sha512 of each installer from it, and checks the download
// against that digest. On Windows and Linux nothing checks who wrote the yml:
// Windows signature verification only runs for a build that carries a
// publisher name, which only a code-signed build does, and AppImage has no
// signature to check. Anyone who can publish a release, through a leaked
// token or a compromised account, gets silent code execution on every user
// at their next quit.
//
// So the release workflow signs every latest*.yml with an Ed25519 key that
// exists only as a repository secret (scripts/sign-update-metadata.mjs), and
// the app refuses to download until it has fetched the yml and its signature
// itself, verified the signature against the public key compiled in here, and
// checked that the version and digests electron-updater is about to trust are
// the signed ones. With the digest chain intact, the installer bytes are then
// authenticated by electron-updater's own sha512 check.
//
// No electron import: this file is exercised directly by the tests.

export interface ExpectedUpdate {
    version: string;
    files: { url: string; sha512: string }[];
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

// The channel file electron-updater reads for this platform, as its Provider
// names it: Windows has no suffix for historical reasons, Linux carries the
// architecture unless it is x64
export function channelFileName(platform: string, arch: string): string {
    if (platform === 'darwin') return 'latest-mac.yml';
    if (platform === 'linux') return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
    return 'latest.yml';
}

export function releaseAssetUrl(owner: string, repo: string, tag: string, asset: string): string {
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

// SPKI DER, base64: what scripts/generate-update-key.mjs prints
export function parsePublicKey(spkiBase64: string): KeyObject {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`Update public key is ${key.asymmetricKeyType}, expected ed25519`);
    }
    return key;
}

function fileName(urlOrPath: string): string {
    // Update file URLs from the GitHub provider end in the asset name, with
    // spaces as dashes; the yml's own paths are the names electron-builder
    // wrote. Compare the decoded last segment of each
    const last = urlOrPath.split('/').pop() ?? urlOrPath;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

// Verifies that `metadata` (the raw bytes of latest*.yml) was signed by the
// holder of the private key, then that it vouches for exactly the update
// electron-updater found: same version, and the same sha512 for every file it
// is about to download. A file the signed document does not list, or lists
// with a different digest, fails the whole check
export function verifyUpdateMetadata(
    metadata: Uint8Array,
    signatureBase64: string,
    publicKey: KeyObject,
    expected: ExpectedUpdate
): VerifyResult {
    let signature: Buffer;
    try {
        signature = Buffer.from(signatureBase64.trim(), 'base64');
    } catch {
        return { ok: false, reason: 'signature is not base64' };
    }
    if (signature.length !== 64) {
        return { ok: false, reason: 'signature has the wrong length' };
    }
    let valid = false;
    try {
        valid = verify(null, metadata, publicKey, signature);
    } catch {
        valid = false;
    }
    if (!valid) {
        return { ok: false, reason: 'signature does not match the metadata' };
    }

    let signed: unknown;
    try {
        signed = load(Buffer.from(metadata).toString('utf8'), { schema: JSON_SCHEMA });
    } catch {
        return { ok: false, reason: 'signed metadata is not valid YAML' };
    }
    if (!signed || typeof signed !== 'object') {
        return { ok: false, reason: 'signed metadata is not a document' };
    }
    const doc = signed as { version?: unknown; files?: unknown };
    if (doc.version !== expected.version) {
        return { ok: false, reason: `signed metadata is for ${String(doc.version)}, not ${expected.version}` };
    }
    const signedFiles = new Map<string, string>();
    for (const file of Array.isArray(doc.files) ? doc.files : []) {
        if (file && typeof file === 'object' && typeof file.url === 'string' && typeof file.sha512 === 'string') {
            signedFiles.set(fileName(file.url), file.sha512);
        }
    }
    if (expected.files.length === 0) {
        return { ok: false, reason: 'update lists no files' };
    }
    for (const file of expected.files) {
        const digest = signedFiles.get(fileName(file.url));
        if (digest === undefined) {
            return { ok: false, reason: `${fileName(file.url)} is not in the signed metadata` };
        }
        if (digest !== file.sha512) {
            return { ok: false, reason: `${fileName(file.url)} has a different digest in the signed metadata` };
        }
    }
    return { ok: true };
}

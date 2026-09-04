import { createHash, createDecipheriv, createPrivateKey, KeyObject } from 'crypto';
import { bcryptPbkdf } from './bcrypt-pbkdf';

// Private key files as they arrive from an entry attachment, turned into the
// wire form the agent protocol takes (draft-miller-ssh-agent). Two routes:
//
//   OpenSSH format ("openssh-key-v1"): the file already holds the key in
//   wire form, encrypted under a bcrypt_pbkdf-derived key when it has a
//   passphrase. Parsed here by hand, since Node's crypto does not read it.
//
//   PEM (PKCS#1, SEC1, PKCS#8, encrypted or not): handed to Node's crypto,
//   which reads every one of them, and rebuilt from the JWK export.
//
// The result carries the public blob (what the agent lists and what removal
// names), the private parts (what add-identity sends), and the comment.

export type SshKeyErrorCode = 'format' | 'passphrase' | 'unsupported';

export class SshKeyError extends Error {
    constructor(message: string, readonly code: SshKeyErrorCode) {
        super(message);
        this.name = 'SshKeyError';
    }
}

export interface SshKeyInfo {
    // Wire type name: ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ...
    type: string;
    // SHA256:<base64, no padding> over the public blob, as ssh-keygen -l prints
    fingerprint: string;
    comment: string;
    // The file is passphrase protected
    encrypted: boolean;
}

export interface ParsedSshKey extends SshKeyInfo {
    publicBlob: Buffer;
    // Everything add-identity sends after the type string: the key parts in
    // wire order, without the comment
    privateParts: Buffer;
}

// Wire encoding helpers

export function wireString(value: Buffer | string): Buffer {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const out = Buffer.alloc(4 + bytes.length);
    out.writeUInt32BE(bytes.length, 0);
    bytes.copy(out, 4);
    return out;
}

export function wireU32(value: number): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0, 0);
    return out;
}

// An unsigned big-endian integer as an mpint: no leading zero bytes, and a
// zero byte in front when the high bit is set so it reads as positive
export function wireMpint(unsigned: Buffer): Buffer {
    let start = 0;
    while (start < unsigned.length - 1 && unsigned[start] === 0) start++;
    const trimmed = unsigned.subarray(start);
    if (trimmed.length === 1 && trimmed[0] === 0) return wireString(Buffer.alloc(0));
    return wireString(trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

export class WireReader {
    private pos: number;

    constructor(private readonly buf: Buffer, start = 0) {
        this.pos = start;
    }

    get remaining(): number {
        return this.buf.length - this.pos;
    }

    u32(): number {
        if (this.remaining < 4) throw new SshKeyError('Truncated key data', 'format');
        const value = this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return value;
    }

    byte(): number {
        if (this.remaining < 1) throw new SshKeyError('Truncated key data', 'format');
        return this.buf[this.pos++];
    }

    bytes(length: number): Buffer {
        if (length < 0 || this.remaining < length) throw new SshKeyError('Truncated key data', 'format');
        const out = this.buf.subarray(this.pos, this.pos + length);
        this.pos += length;
        return out;
    }

    string(): Buffer {
        return this.bytes(this.u32());
    }

    text(): string {
        return this.string().toString('utf8');
    }
}

export function fingerprintOf(publicBlob: Buffer): string {
    return 'SHA256:' + createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '');
}

// How many wire strings follow the type in a private key of each type. The
// sk- types carry a byte flag among their parts and need an sk provider on
// the agent side, so they are refused rather than mis-parsed
const PRIVATE_PARTS: Record<string, number> = {
    'ssh-rsa': 6,       // n e d iqmp p q
    'ssh-dss': 5,       // p q g y x
    'ecdsa-sha2-nistp256': 3, // curve Q d
    'ecdsa-sha2-nistp384': 3,
    'ecdsa-sha2-nistp521': 3,
    'ssh-ed25519': 2,   // pk sk
};

function typeOfPublicBlob(blob: Buffer): string {
    return new WireReader(blob).text();
}

function requireSupportedType(type: string): void {
    if (PRIVATE_PARTS[type]) return;
    if (type.startsWith('sk-')) {
        throw new SshKeyError('Security key backed (sk-) keys are not supported', 'unsupported');
    }
    throw new SshKeyError(`Unsupported key type ${type}`, 'unsupported');
}

// OpenSSH format

const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');

interface CipherSpec {
    node: string;
    keyLength: number;
    ivLength: number;
    // Authentication tag appended after the private section in the file
    tagLength: number;
}

const CIPHERS: Record<string, CipherSpec> = {
    'aes128-ctr': { node: 'aes-128-ctr', keyLength: 16, ivLength: 16, tagLength: 0 },
    'aes192-ctr': { node: 'aes-192-ctr', keyLength: 24, ivLength: 16, tagLength: 0 },
    'aes256-ctr': { node: 'aes-256-ctr', keyLength: 32, ivLength: 16, tagLength: 0 },
    'aes128-cbc': { node: 'aes-128-cbc', keyLength: 16, ivLength: 16, tagLength: 0 },
    'aes192-cbc': { node: 'aes-192-cbc', keyLength: 24, ivLength: 16, tagLength: 0 },
    'aes256-cbc': { node: 'aes-256-cbc', keyLength: 32, ivLength: 16, tagLength: 0 },
    'aes256-gcm@openssh.com': { node: 'aes-256-gcm', keyLength: 32, ivLength: 12, tagLength: 16 },
};

function pemBody(text: string, label: string): Buffer {
    const match = text.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`));
    if (!match) throw new SshKeyError('Malformed key file', 'format');
    const base64 = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
    if (!base64) throw new SshKeyError('Malformed key file', 'format');
    return Buffer.from(base64, 'base64');
}

interface OpenSshHeader {
    cipherName: string;
    kdfName: string;
    kdfOptions: Buffer;
    publicBlob: Buffer;
    privateSection: Buffer;
    tag: Buffer;
}

function readOpenSshHeader(text: string): OpenSshHeader {
    const raw = pemBody(text, 'OPENSSH PRIVATE KEY');
    if (raw.length < OPENSSH_MAGIC.length || !raw.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
        throw new SshKeyError('Malformed OpenSSH key', 'format');
    }
    const reader = new WireReader(raw, OPENSSH_MAGIC.length);
    const cipherName = reader.text();
    const kdfName = reader.text();
    const kdfOptions = reader.string();
    const keyCount = reader.u32();
    // The format allows several; nothing writes more than one and the agent
    // takes one at a time
    if (keyCount !== 1) throw new SshKeyError(`Expected one key in the file, found ${keyCount}`, 'unsupported');
    const publicBlob = Buffer.from(reader.string());
    const privateSection = Buffer.from(reader.string());
    const spec = CIPHERS[cipherName];
    const tag = spec && spec.tagLength ? Buffer.from(reader.bytes(spec.tagLength)) : Buffer.alloc(0);
    return { cipherName, kdfName, kdfOptions, publicBlob, privateSection, tag };
}

function decryptPrivateSection(header: OpenSshHeader, passphrase: string): Buffer {
    if (header.cipherName === 'none') return header.privateSection;
    const spec = CIPHERS[header.cipherName];
    if (!spec) {
        throw new SshKeyError(`Unsupported cipher ${header.cipherName}; re-encrypt the key with aes256-ctr`, 'unsupported');
    }
    if (header.kdfName !== 'bcrypt') throw new SshKeyError(`Unsupported KDF ${header.kdfName}`, 'unsupported');
    if (!passphrase) throw new SshKeyError('This key needs a passphrase', 'passphrase');

    const options = new WireReader(header.kdfOptions);
    const salt = options.string();
    const rounds = options.u32();
    const derived = bcryptPbkdf(Buffer.from(passphrase, 'utf8'), salt, spec.keyLength + spec.ivLength, rounds);
    const key = derived.subarray(0, spec.keyLength);
    const iv = derived.subarray(spec.keyLength);

    try {
        const decipher = createDecipheriv(spec.node, key, iv);
        decipher.setAutoPadding(false);
        if (spec.tagLength) (decipher as unknown as { setAuthTag(tag: Buffer): void }).setAuthTag(header.tag);
        return Buffer.concat([decipher.update(header.privateSection), decipher.final()]);
    } catch {
        // The AEAD refuses outright; the others produce garbage that the
        // check words below catch
        throw new SshKeyError('Wrong passphrase', 'passphrase');
    } finally {
        derived.fill(0);
    }
}

function parseOpenSsh(text: string, passphrase: string): ParsedSshKey {
    const header = readOpenSshHeader(text);
    const type = typeOfPublicBlob(header.publicBlob);
    requireSupportedType(type);
    const encrypted = header.cipherName !== 'none';
    const plain = decryptPrivateSection(header, passphrase);

    const reader = new WireReader(plain);
    if (reader.u32() !== reader.u32()) throw new SshKeyError('Wrong passphrase', 'passphrase');
    const privateType = reader.text();
    if (privateType !== type) throw new SshKeyError('Malformed OpenSSH key', 'format');
    const partsStart = plain.length - reader.remaining;
    for (let i = 0; i < PRIVATE_PARTS[type]; i++) reader.string();
    const partsEnd = plain.length - reader.remaining;
    const comment = reader.text();

    return {
        type,
        fingerprint: fingerprintOf(header.publicBlob),
        comment,
        encrypted,
        publicBlob: header.publicBlob,
        privateParts: Buffer.from(plain.subarray(partsStart, partsEnd)),
    };
}

// PEM formats, through Node's crypto

const b64url = (value: string | undefined): Buffer => {
    if (typeof value !== 'string') throw new SshKeyError('Malformed key', 'format');
    return Buffer.from(value, 'base64url');
};

const EC_CURVES: Record<string, { name: string; bytes: number }> = {
    'P-256': { name: 'nistp256', bytes: 32 },
    'P-384': { name: 'nistp384', bytes: 48 },
    'P-521': { name: 'nistp521', bytes: 66 },
};

const leftPad = (value: Buffer, length: number): Buffer =>
    value.length >= length ? value : Buffer.concat([Buffer.alloc(length - value.length), value]);

function fromKeyObject(key: KeyObject, encrypted: boolean): ParsedSshKey {
    const jwk = key.export({ format: 'jwk' }) as Record<string, string | undefined>;
    let type: string;
    let publicParts: Buffer[];
    let privateParts: Buffer[];

    switch (key.asymmetricKeyType) {
        case 'rsa': {
            type = 'ssh-rsa';
            const n = b64url(jwk.n);
            const e = b64url(jwk.e);
            publicParts = [wireMpint(e), wireMpint(n)];
            privateParts = [
                wireMpint(n), wireMpint(e), wireMpint(b64url(jwk.d)),
                wireMpint(b64url(jwk.qi)), wireMpint(b64url(jwk.p)), wireMpint(b64url(jwk.q)),
            ];
            break;
        }
        case 'ec': {
            const curve = EC_CURVES[jwk.crv ?? ''];
            if (!curve) throw new SshKeyError(`Unsupported curve ${jwk.crv}`, 'unsupported');
            type = `ecdsa-sha2-${curve.name}`;
            const point = Buffer.concat([
                Buffer.from([0x04]),
                leftPad(b64url(jwk.x), curve.bytes),
                leftPad(b64url(jwk.y), curve.bytes),
            ]);
            publicParts = [wireString(curve.name), wireString(point)];
            privateParts = [wireString(curve.name), wireString(point), wireMpint(b64url(jwk.d))];
            break;
        }
        case 'ed25519': {
            type = 'ssh-ed25519';
            const pk = b64url(jwk.x);
            const seed = b64url(jwk.d);
            publicParts = [wireString(pk)];
            privateParts = [wireString(pk), wireString(Buffer.concat([seed, pk]))];
            break;
        }
        case 'dsa':
            throw new SshKeyError('DSA keys are not supported; OpenSSH itself no longer accepts them', 'unsupported');
        default:
            throw new SshKeyError(`Unsupported key type ${key.asymmetricKeyType}`, 'unsupported');
    }

    const publicBlob = Buffer.concat([wireString(type), ...publicParts]);
    return {
        type,
        fingerprint: fingerprintOf(publicBlob),
        comment: '',
        encrypted,
        publicBlob,
        privateParts: Buffer.concat(privateParts),
    };
}

function parsePem(text: string, passphrase: string): ParsedSshKey {
    const encrypted = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/i.test(text);
    if (encrypted && !passphrase) throw new SshKeyError('This key needs a passphrase', 'passphrase');
    let key: KeyObject;
    try {
        key = createPrivateKey({ key: text, format: 'pem', passphrase: encrypted ? passphrase : undefined });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (encrypted || /passphrase|bad decrypt/i.test(message)) {
            throw new SshKeyError('Wrong passphrase', 'passphrase');
        }
        throw new SshKeyError('Malformed key file', 'format');
    }
    return fromKeyObject(key, encrypted);
}

// Entry points

function asText(data: Uint8Array): string {
    const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    if (text.includes('�') && !text.includes('-----BEGIN')) {
        throw new SshKeyError('Not a private key file', 'format');
    }
    return text;
}

export function looksLikePrivateKey(data: Uint8Array): boolean {
    const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 128)).toString('latin1');
    return /-----BEGIN (OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(head) || head.startsWith('PuTTY-User-Key-File');
}

export function parsePrivateKey(data: Uint8Array, passphrase = ''): ParsedSshKey {
    const text = asText(data);
    if (text.startsWith('PuTTY-User-Key-File')) {
        throw new SshKeyError('PuTTY keys are not supported; export the key in OpenSSH format from PuTTYgen', 'unsupported');
    }
    if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) return parseOpenSsh(text, passphrase);
    if (/-----BEGIN (RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) return parsePem(text, passphrase);
    throw new SshKeyError('Not a private key file', 'format');
}

// The public blob, which removal from the agent is keyed on. An OpenSSH file
// gives it up without the passphrase; a PEM file has to be opened
export function publicBlobOf(data: Uint8Array, passphrase = ''): Buffer {
    const text = asText(data);
    if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) return readOpenSshHeader(text).publicBlob;
    return parsePrivateKey(data, passphrase).publicBlob;
}

// What can be said about the key without its passphrase. An OpenSSH file
// carries the public half in the clear; a PEM file gives nothing away until
// it is opened, so it reads as encrypted with no type
export function readPublicInfo(data: Uint8Array): SshKeyInfo {
    const text = asText(data);
    if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) {
        const header = readOpenSshHeader(text);
        const type = typeOfPublicBlob(header.publicBlob);
        requireSupportedType(type);
        let comment = '';
        if (header.cipherName === 'none') {
            try {
                comment = parseOpenSsh(text, '').comment;
            } catch { /* the public half still stands */ }
        }
        return { type, fingerprint: fingerprintOf(header.publicBlob), comment, encrypted: header.cipherName !== 'none' };
    }
    const encrypted = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/i.test(text);
    if (encrypted) return { type: '', fingerprint: '', comment: '', encrypted: true };
    const key = parsePrivateKey(data, '');
    return { type: key.type, fingerprint: key.fingerprint, comment: key.comment, encrypted: false };
}

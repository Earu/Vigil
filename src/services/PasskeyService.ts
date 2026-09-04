import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';

// The public suffix list is 125 KB minified, for a check that runs once per
// passkey ceremony. Fetched on first use rather than carried in the startup
// chunk, the way the strength estimator is
let suffixList: Promise<typeof import('tldts')> | null = null;
const loadSuffixList = (): Promise<typeof import('tldts')> => {
    if (!suffixList) {
        suffixList = import('tldts');
        // A failed chunk load retries on the next ceremony
        suffixList.catch(() => { suffixList = null; });
    }
    return suffixList;
};

// WebAuthn authenticator for the KeePassXC-Browser passkeys protocol
// (passkeys-register / passkeys-get). Response shapes, entry attributes and
// crypto choices mirror KeePassXC (BrowserPasskeys.cpp) so databases stay
// interchangeable: ES256/RS256/Ed25519 keys stored as PKCS#8 PEM in
// KPEX_PASSKEY_* attributes, "none" attestation, DER ECDSA signatures,
// zero signature counter, KeePassXC's AAGUID.

export const PASSKEY_ATTRIBUTES = {
    username: 'KPEX_PASSKEY_USERNAME',
    credentialId: 'KPEX_PASSKEY_CREDENTIAL_ID',
    privateKeyPem: 'KPEX_PASSKEY_PRIVATE_KEY_PEM',
    relyingParty: 'KPEX_PASSKEY_RELYING_PARTY',
    userHandle: 'KPEX_PASSKEY_USER_HANDLE',
    // Written by StrongBox instead of credentialId; read for compatibility
    generatedUserId: 'KPEX_PASSKEY_GENERATED_USER_ID',
} as const;

export const PASSKEYS_GROUP_NAME = 'KeePassXC-Browser Passkeys';

// KeePassXC's AAGUID, so relying parties see the same authenticator model
const AAGUID_HEX = 'fdb141b25d84443e8a354698c205a502';

export const PASSKEY_ERRORS = {
    NO_LOGINS_FOUND: 15,
    CREDENTIAL_IS_EXCLUDED: 21,
    REQUEST_CANCELED: 22,
    EMPTY_PUBLIC_KEY: 24,
    ORIGIN_NOT_ALLOWED: 26,
    DOMAIN_IS_NOT_VALID: 27,
    DOMAIN_RPID_MISMATCH: 28,
    NO_SUPPORTED_ALGORITHMS: 29,
    WAIT_FOR_LIFETIMER: 30,
    UNKNOWN_ERROR: 31,
    INVALID_CHALLENGE: 32,
    INVALID_USER_ID: 33,
} as const;

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;

// ---- encoding helpers ----

export const b64urlEncode = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

export const b64urlDecode = (text: string): Uint8Array =>
    Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const hexToBytes = (hex: string): Uint8Array =>
    new Uint8Array(hex.match(/../g)!.map(b => parseInt(b, 16)));

const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
};

const pemEncode = (pkcs8: Uint8Array): string => {
    const body = btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)!.join('\n');
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
};

const pemDecode = (pem: string): Uint8Array =>
    Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0));

// ---- minimal CBOR encoder (definite lengths only, what WebAuthn needs) ----

const cborUint = (majorType: number, value: number): Uint8Array => {
    const mt = majorType << 5;
    if (value < 24) return new Uint8Array([mt | value]);
    if (value < 0x100) return new Uint8Array([mt | 24, value]);
    if (value < 0x10000) return new Uint8Array([mt | 25, value >> 8, value & 0xff]);
    return new Uint8Array([mt | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
};

export const cbor = {
    int(value: number): Uint8Array {
        return value >= 0 ? cborUint(0, value) : cborUint(1, -value - 1);
    },
    bytes(value: Uint8Array): Uint8Array {
        return concat(cborUint(2, value.length), value);
    },
    text(value: string): Uint8Array {
        const utf8 = new TextEncoder().encode(value);
        return concat(cborUint(3, utf8.length), utf8);
    },
    // entries are pre-encoded key/value pairs
    map(entries: Array<[Uint8Array, Uint8Array]>): Uint8Array {
        return concat(cborUint(5, entries.length), ...entries.flatMap(([k, v]) => [k, v]));
    },
};

// ---- WebAuthn structures ----

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice().buffer));

// UP (bit 0) + UV (bit 2), AT (bit 6) when attested credential data follows
const flagsByte = (attestedData: boolean): number => 0x01 | 0x04 | (attestedData ? 0x40 : 0);

const ZERO_COUNTER = new Uint8Array([0, 0, 0, 0]);

async function buildAuthenticatorData(rpId: string): Promise<Uint8Array> {
    const rpIdHash = await sha256(new TextEncoder().encode(rpId));
    return concat(rpIdHash, new Uint8Array([flagsByte(false)]), ZERO_COUNTER);
}

async function buildAttestedAuthenticatorData(
    rpId: string, credentialId: Uint8Array, cosePublicKey: Uint8Array
): Promise<Uint8Array> {
    const rpIdHash = await sha256(new TextEncoder().encode(rpId));
    const credLength = new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]);
    return concat(rpIdHash, new Uint8Array([flagsByte(true)]), ZERO_COUNTER,
        hexToBytes(AAGUID_HEX), credLength, credentialId, cosePublicKey);
}

const buildAttestationObject = (authData: Uint8Array): Uint8Array =>
    cbor.map([
        [cbor.text('fmt'), cbor.text('none')],
        [cbor.text('attStmt'), cbor.map([])],
        [cbor.text('authData'), cbor.bytes(authData)],
    ]);

// Same field order as KeePassXC (QJson serializes keys alphabetically)
const buildClientDataJson = (challenge: string, origin: string, get: boolean): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({
        challenge,
        crossOrigin: false,
        origin,
        type: get ? 'webauthn.get' : 'webauthn.create',
    }));

// ---- key generation and signing ----

interface GeneratedKey {
    cosePublicKey: Uint8Array;
    privateKeyPem: string;
}

async function generateCredentialKey(alg: number): Promise<GeneratedKey> {
    if (alg === ES256) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        // raw = 0x04 || x(32) || y(32)
        const x = raw.slice(1, 33);
        const y = raw.slice(33, 65);
        const cosePublicKey = cbor.map([
            [cbor.int(1), cbor.int(2)],       // kty: EC2
            [cbor.int(3), cbor.int(ES256)],   // alg
            [cbor.int(-1), cbor.int(1)],      // crv: P-256
            [cbor.int(-2), cbor.bytes(x)],
            [cbor.int(-3), cbor.bytes(y)],
        ]);
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
        return { cosePublicKey, privateKeyPem: pemEncode(pkcs8) };
    }
    if (alg === RS256) {
        const pair = await crypto.subtle.generateKey({
            name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
        }, true, ['sign']);
        const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
        const modulus = b64urlDecode(jwk.n!);
        const exponent = b64urlDecode(jwk.e!);
        const cosePublicKey = cbor.map([
            [cbor.int(1), cbor.int(3)],       // kty: RSA
            [cbor.int(3), cbor.int(RS256)],
            [cbor.int(-1), cbor.bytes(modulus)],
            [cbor.int(-2), cbor.bytes(exponent)],
        ]);
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
        return { cosePublicKey, privateKeyPem: pemEncode(pkcs8) };
    }
    if (alg === EDDSA) {
        // Ed25519 support depends on the runtime; callers fall back to ES256
        const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign']) as CryptoKeyPair;
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const cosePublicKey = cbor.map([
            [cbor.int(1), cbor.int(1)],       // kty: OKP
            [cbor.int(3), cbor.int(EDDSA)],
            [cbor.int(-1), cbor.int(6)],      // crv: Ed25519
            [cbor.int(-2), cbor.bytes(raw)],
        ]);
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
        return { cosePublicKey, privateKeyPem: pemEncode(pkcs8) };
    }
    throw new Error(`Unsupported algorithm ${alg}`);
}

// WebCrypto ECDSA signatures are raw r||s; WebAuthn wants an ASN.1 DER sequence
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
    const encodeInt = (bytes: Uint8Array): Uint8Array => {
        let start = 0;
        while (start < bytes.length - 1 && bytes[start] === 0) start++;
        let body = bytes.slice(start);
        if (body[0] & 0x80) body = concat(new Uint8Array([0]), body);
        return concat(new Uint8Array([0x02, body.length]), body);
    };
    const half = raw.length / 2;
    const r = encodeInt(raw.slice(0, half));
    const s = encodeInt(raw.slice(half));
    return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

async function importPrivateKey(pem: string): Promise<{ key: CryptoKey; alg: number }> {
    const pkcs8 = pemDecode(pem);
    const buffer = pkcs8.slice().buffer;
    try {
        const key = await crypto.subtle.importKey('pkcs8', buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        return { key, alg: ES256 };
    } catch { /* not P-256 */ }
    try {
        const key = await crypto.subtle.importKey('pkcs8', buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        return { key, alg: RS256 };
    } catch { /* not RSA */ }
    const key = await crypto.subtle.importKey('pkcs8', buffer, 'Ed25519', false, ['sign']);
    return { key, alg: EDDSA };
}

async function signWebAuthn(pem: string, authData: Uint8Array, clientDataJson: Uint8Array): Promise<Uint8Array> {
    const clientDataHash = await sha256(clientDataJson);
    const toSign = concat(authData, clientDataHash).slice().buffer;
    const { key, alg } = await importPrivateKey(pem);
    if (alg === ES256) {
        const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, toSign));
        return ecdsaRawToDer(raw);
    }
    if (alg === RS256) {
        return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, toSign));
    }
    return new Uint8Array(await crypto.subtle.sign('Ed25519', key, toSign));
}

// ---- rpId and origin validation ----

export function effectiveDomain(origin: string): string | null {
    try {
        const host = new URL(origin).hostname.toLowerCase();
        return host || null;
    } catch {
        return null;
    }
}

const normalizeOrigin = (origin: string): string | null => {
    try {
        return new URL(origin).origin.toLowerCase();
    } catch {
        return null;
    }
};

// Whether a host is a public suffix (com, co.uk, github.io): a name under
// which unrelated parties register, so nothing can claim it as its own.
// Private-section entries count, since user.github.io and other.github.io
// are as unrelated as two .com sites. A host the list knows nothing about
// (an IP address) is treated as one too, which fails closed
export async function isPublicSuffix(host: string): Promise<boolean> {
    const { getPublicSuffix } = await loadSuffixList();
    const suffix = getPublicSuffix(host, { allowPrivateDomains: true });
    return suffix === null || suffix === host;
}

// The RP ID must equal the origin's domain or be a registrable suffix of it
// (HTML's "is a registrable domain suffix of or is equal to"). A suffix that
// is itself a public suffix is refused: otherwise a site could register a
// credential under "com" and have it offered to every other .com site, and
// the extension intercepts the WebAuthn call before Chromium's own check
// runs, so this is the only place the check happens. KeePassXC does the
// same with its bundled suffix list. Failing that, an rpId is still accepted
// when the caller's origin appears in the RP's related-origins list
// (https://<rpId>/.well-known/webauthn, fetched and validated by the browser
// extension)
export async function validateRpId(
    rpId: string | undefined,
    domain: string,
    origin?: string,
    relatedOrigins?: string[],
): Promise<string | null> {
    if (!rpId) return domain;
    const suffix = rpId.toLowerCase();
    if (suffix === domain) return suffix;
    // Neither a public suffix nor the tail of an IP address is a
    // relationship, whatever the related-origins list says
    const { parse } = await loadSuffixList();
    if (await isPublicSuffix(suffix) || parse(domain).isIp) return null;
    if (domain.endsWith('.' + suffix)) return suffix;
    if (origin && Array.isArray(relatedOrigins) && relatedOrigins.length > 0) {
        const caller = normalizeOrigin(origin);
        if (caller && relatedOrigins.some(o => normalizeOrigin(String(o)) === caller)) {
            return suffix;
        }
    }
    return null;
}

export function originAllowed(origin: string, allowLocalhost: boolean): boolean {
    if (origin.startsWith('https://')) return true;
    if (!allowLocalhost) return false;
    const host = effectiveDomain(origin);
    return host === 'localhost' || (host?.endsWith('.localhost') ?? false);
}

// ---- entry handling ----

export interface PasskeyEntryInfo {
    entry: kdbxweb.KdbxEntry;
    title: string;
    username: string;
    credentialId: string;
    userHandle: string;
    relyingParty: string;
}

const attr = (entry: kdbxweb.KdbxEntry, name: string): string => {
    const value = entry.fields.get(name);
    if (value === undefined) return '';
    return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
};

function* allEntries(group: kdbxweb.KdbxGroup, recycleBinUuid?: string): Generator<kdbxweb.KdbxEntry> {
    if (recycleBinUuid && group.uuid.id === recycleBinUuid) return;
    for (const entry of group.entries) yield entry;
    for (const child of group.groups) yield* allEntries(child, recycleBinUuid);
}

export class PasskeyService {
    static isPasskeyFieldKey(key: string): boolean {
        return Object.values(PASSKEY_ATTRIBUTES).includes(key as any);
    }

    // Summary for UI, from the app's custom-field list; null when the entry
    // holds no passkey
    static passkeyFromFields(
        fields: Array<{ key: string; value: string | kdbxweb.ProtectedValue }>,
    ): { relyingParty: string; username: string } | null {
        const get = (name: string): string => {
            const field = fields.find(f => f.key === name);
            if (!field) return '';
            return field.value instanceof kdbxweb.ProtectedValue ? field.value.getText() : String(field.value);
        };
        const credentialId = get(PASSKEY_ATTRIBUTES.generatedUserId) || get(PASSKEY_ATTRIBUTES.credentialId);
        if (!credentialId || !get(PASSKEY_ATTRIBUTES.privateKeyPem)) return null;
        return {
            relyingParty: get(PASSKEY_ATTRIBUTES.relyingParty),
            username: get(PASSKEY_ATTRIBUTES.username),
        };
    }

    static passkeyEntries(kdbxDb: kdbxweb.Kdbx, rpId: string): PasskeyEntryInfo[] {
        const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
        const result: PasskeyEntryInfo[] = [];
        for (const entry of allEntries(kdbxDb.getDefaultGroup(), recycleBinUuid)) {
            if (attr(entry, PASSKEY_ATTRIBUTES.relyingParty) !== rpId) continue;
            const credentialId = attr(entry, PASSKEY_ATTRIBUTES.generatedUserId) || attr(entry, PASSKEY_ATTRIBUTES.credentialId);
            if (!credentialId) continue;
            result.push({
                entry,
                title: attr(entry, 'Title'),
                username: attr(entry, PASSKEY_ATTRIBUTES.username) || attr(entry, 'UserName'),
                credentialId,
                userHandle: attr(entry, PASSKEY_ATTRIBUTES.userHandle),
                relyingParty: rpId,
            });
        }
        return result;
    }

    // Ed25519 in WebCrypto depends on the runtime; probe once
    private static ed25519Support: boolean | null = null;
    static async supportsEd25519(): Promise<boolean> {
        if (this.ed25519Support === null) {
            try {
                await crypto.subtle.generateKey('Ed25519', false, ['sign']);
                this.ed25519Support = true;
            } catch {
                this.ed25519Support = false;
            }
        }
        return this.ed25519Support;
    }

    // First supported algorithm in the RP's preference order wins, ES256 if
    // the list is absent (KeePassXC order)
    static async pickAlgorithm(pubKeyCredParams: Array<{ type: string; alg: number }> | undefined): Promise<number | null> {
        if (!pubKeyCredParams || pubKeyCredParams.length === 0) return ES256;
        for (const param of pubKeyCredParams) {
            if (param.type !== 'public-key') continue;
            if (param.alg === EDDSA && !(await this.supportsEd25519())) continue;
            if ([ES256, RS256, EDDSA].includes(param.alg)) return param.alg;
        }
        return null;
    }

    static async register(
        kdbxDb: kdbxweb.Kdbx,
        options: any,
        origin: string,
        groupName: string | undefined,
        opts: { allowLocalhost?: boolean; relatedOrigins?: string[] } = {},
    ): Promise<{ response: any; store?: () => void; rpId?: string; username?: string }> {
        const error = (errorCode: number) => ({ response: { errorCode } });

        if (!options || !options.challenge) return error(PASSKEY_ERRORS.EMPTY_PUBLIC_KEY);
        if (!originAllowed(origin, opts.allowLocalhost ?? false)) return error(PASSKEY_ERRORS.ORIGIN_NOT_ALLOWED);
        if (String(options.challenge).length < 16) return error(PASSKEY_ERRORS.INVALID_CHALLENGE);

        const userId = options.user?.id ? b64urlDecode(String(options.user.id)) : new Uint8Array();
        if (userId.length < 1 || userId.length > 64) return error(PASSKEY_ERRORS.INVALID_USER_ID);

        const domain = effectiveDomain(origin);
        if (!domain) return error(PASSKEY_ERRORS.DOMAIN_IS_NOT_VALID);
        const rpId = await validateRpId(options.rp?.id, domain, origin, opts.relatedOrigins);
        if (!rpId) return error(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);

        const alg = await this.pickAlgorithm(options.pubKeyCredParams);
        if (alg === null) return error(PASSKEY_ERRORS.NO_SUPPORTED_ALGORITHMS);

        // A credential the RP already knows must not be re-registered
        const existing = this.passkeyEntries(kdbxDb, rpId);
        const excludeIds: string[] = (options.excludeCredentials ?? [])
            .map((c: any) => String(c.id));
        if (excludeIds.length > 0 && existing.some(e => excludeIds.includes(e.credentialId))) {
            return error(PASSKEY_ERRORS.CREDENTIAL_IS_EXCLUDED);
        }

        const credentialId = crypto.getRandomValues(new Uint8Array(32));
        const credentialIdB64 = b64urlEncode(credentialId);
        let generated: GeneratedKey;
        try {
            generated = await generateCredentialKey(alg);
        } catch {
            return error(PASSKEY_ERRORS.UNKNOWN_ERROR);
        }

        const attestedAuthData = await buildAttestedAuthenticatorData(rpId, credentialId, generated.cosePublicKey);
        const authenticatorData = await buildAuthenticatorData(rpId);
        const clientDataJson = buildClientDataJson(String(options.challenge), origin, false);

        const username = options.user?.name ?? '';
        const rpName = options.rp?.name ?? rpId;
        const userHandle = String(options.user?.id ?? '');

        const store = () => {
            // Same user handle on the same RP replaces the existing passkey
            const updatable = existing.find(e => e.userHandle === userHandle);
            let entry: kdbxweb.KdbxEntry;
            if (updatable) {
                entry = updatable.entry;
                entry.pushHistory();
                // Values rewritten outside any UI model: a save from a model
                // built before this write must not push them back
                KeepassDatabaseService.registerUnmodeledEdits([entry.uuid.toString()]);
            } else {
                const root = kdbxDb.getDefaultGroup();
                const name = groupName || PASSKEYS_GROUP_NAME;
                let group = root.groups.find(g => g.name === name);
                if (!group) {
                    group = kdbxDb.createGroup(root, name);
                    KeepassDatabaseService.registerUnmodeledUuids([group.uuid.toString()]);
                }
                entry = kdbxDb.createEntry(group);
                // Created outside any UI model: without this a save from a
                // model built before this write would tombstone the passkey
                KeepassDatabaseService.registerUnmodeledUuids([entry.uuid.toString()]);
                entry.fields.set('Title', `${rpName} (Passkey)`);
                entry.fields.set('UserName', username);
                entry.fields.set('URL', origin);
            }
            entry.fields.set(PASSKEY_ATTRIBUTES.username, username);
            entry.fields.set(PASSKEY_ATTRIBUTES.credentialId, kdbxweb.ProtectedValue.fromString(credentialIdB64));
            entry.fields.set(PASSKEY_ATTRIBUTES.privateKeyPem, kdbxweb.ProtectedValue.fromString(generated.privateKeyPem));
            entry.fields.set(PASSKEY_ATTRIBUTES.relyingParty, rpId);
            entry.fields.set(PASSKEY_ATTRIBUTES.userHandle, kdbxweb.ProtectedValue.fromString(userHandle));
            if (!entry.tags.includes('Passkey')) entry.tags.push('Passkey');
            entry.times.lastModTime = new Date();
        };

        return {
            store,
            rpId,
            username,
            response: {
                authenticatorAttachment: options.authenticatorSelection?.authenticatorAttachment || 'platform',
                id: credentialIdB64,
                type: 'public-key',
                response: {
                    attestationObject: b64urlEncode(buildAttestationObject(attestedAuthData)),
                    clientDataJSON: b64urlEncode(clientDataJson),
                    clientExtensionResults: {},
                    // KeePassXC returns the short (non-attested) form here
                    authenticatorData: b64urlEncode(authenticatorData),
                    publicKeyAlgorithm: alg,
                },
            },
        };
    }

    // Entries eligible for an assertion; the consent dialog picks from these
    static async allowedEntries(
        kdbxDb: kdbxweb.Kdbx,
        options: any,
        origin: string,
        opts: { allowLocalhost?: boolean; relatedOrigins?: string[] } = {},
    ): Promise<{ errorCode: number } | { rpId: string; entries: PasskeyEntryInfo[] }> {
        if (!options || !options.challenge) return { errorCode: PASSKEY_ERRORS.EMPTY_PUBLIC_KEY };
        if (!originAllowed(origin, opts.allowLocalhost ?? false)) return { errorCode: PASSKEY_ERRORS.ORIGIN_NOT_ALLOWED };

        const domain = effectiveDomain(origin);
        if (!domain) return { errorCode: PASSKEY_ERRORS.DOMAIN_IS_NOT_VALID };
        const rpId = await validateRpId(options.rpId, domain, origin, opts.relatedOrigins);
        if (!rpId) return { errorCode: PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH };

        const allowedIds: string[] = (options.allowCredentials ?? [])
            .filter((c: any) => c.type === 'public-key' && c.id)
            .map((c: any) => String(c.id));

        const entries = this.passkeyEntries(kdbxDb, rpId).filter(e =>
            allowedIds.length > 0 ? allowedIds.includes(e.credentialId) : !!e.userHandle);
        if (entries.length === 0) return { errorCode: PASSKEY_ERRORS.NO_LOGINS_FOUND };
        return { rpId, entries };
    }

    static async assert(selected: PasskeyEntryInfo, options: any, origin: string, rpId: string): Promise<any> {
        const privateKeyPem = attr(selected.entry, PASSKEY_ATTRIBUTES.privateKeyPem);
        if (!privateKeyPem) return { errorCode: PASSKEY_ERRORS.UNKNOWN_ERROR };

        const authenticatorData = await buildAuthenticatorData(rpId);
        const clientDataJson = buildClientDataJson(String(options.challenge), origin, true);
        let signature: Uint8Array;
        try {
            signature = await signWebAuthn(privateKeyPem, authenticatorData, clientDataJson);
        } catch {
            return { errorCode: PASSKEY_ERRORS.UNKNOWN_ERROR };
        }

        return {
            authenticatorAttachment: 'platform',
            id: selected.credentialId,
            type: 'public-key',
            response: {
                authenticatorData: b64urlEncode(authenticatorData),
                clientDataJSON: b64urlEncode(clientDataJson),
                clientExtensionResults: {},
                signature: b64urlEncode(signature),
                userHandle: selected.userHandle,
            },
        };
    }
}

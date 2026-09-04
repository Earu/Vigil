import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { cred } from './helpers';
import {
    PasskeyService,
    PASSKEY_ATTRIBUTES,
    PASSKEY_ERRORS,
    PASSKEYS_GROUP_NAME,
    b64urlEncode,
    b64urlDecode,
    ecdsaRawToDer,
} from '../src/services/PasskeyService';

const origin = 'https://example.com';
const rpId = 'example.com';
const challenge = b64urlEncode(new Uint8Array(32).fill(7));
const userIdBytes = new Uint8Array([1, 2, 3, 4]);
const userId = b64urlEncode(userIdBytes);

const creationOptions = (overrides: any = {}) => ({
    challenge,
    rp: { id: rpId, name: 'Example' },
    user: { id: userId, name: 'alice', displayName: 'Alice' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { userVerification: 'preferred' },
    excludeCredentials: [],
    ...overrides,
});

const makeDb = () => {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(4);
    return db;
};

// ---- CBOR / authData parsing helpers for verification ----
const parseAttestationObject = (b64: string) => {
    const bytes = b64urlDecode(b64);
    // top-level map: { fmt, attStmt, authData }; authData is the 3rd value,
    // a byte string. Find it by locating the "authData" text key.
    const marker = new TextEncoder().encode('authData');
    let idx = -1;
    for (let i = 0; i < bytes.length - marker.length; i++) {
        if (marker.every((b, j) => bytes[i + j] === b)) { idx = i + marker.length; break; }
    }
    if (idx < 0) throw new Error('authData not found');
    // next byte is a CBOR byte-string header (major type 2)
    let p = idx;
    const initial = bytes[p++];
    const info = initial & 0x1f;
    let len: number;
    if (info < 24) len = info;
    else if (info === 24) len = bytes[p++];
    else if (info === 25) { len = (bytes[p++] << 8) | bytes[p++]; }
    else { len = (bytes[p++] << 24) | (bytes[p++] << 16) | (bytes[p++] << 8) | bytes[p++]; }
    return bytes.slice(p, p + len);
};

const parseAuthData = (authData: Uint8Array) => {
    const flags = authData[32];
    const credIdLen = (authData[53] << 8) | authData[54];
    const credentialId = authData.slice(55, 55 + credIdLen);
    const cosePublicKey = authData.slice(55 + credIdLen);
    return { flags, credentialId, cosePublicKey, rpIdHash: authData.slice(0, 32) };
};

// Extract EC2 x/y from a COSE key (map with keys -2, -3 as byte strings)
const coseEcPublicKey = (cose: Uint8Array): { x: Uint8Array; y: Uint8Array } => {
    // walk the small map; keys are negative small ints (0x21 = -2, 0x22 = -3)
    let x: Uint8Array | null = null, y: Uint8Array | null = null;
    for (let i = 0; i < cose.length; i++) {
        if ((cose[i] === 0x21 || cose[i] === 0x22) && cose[i + 1] === 0x58 && cose[i + 2] === 0x20) {
            const val = cose.slice(i + 3, i + 3 + 32);
            if (cose[i] === 0x21) x = val; else y = val;
        }
    }
    if (!x || !y) throw new Error('EC key coords not found');
    return { x, y };
};

const importCoseEcKey = async (cose: Uint8Array): Promise<CryptoKey> => {
    const { x, y } = coseEcPublicKey(cose);
    const raw = new Uint8Array(65);
    raw[0] = 0x04; raw.set(x, 1); raw.set(y, 33);
    return crypto.subtle.importKey('raw', raw.slice().buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
};

const derToRaw = (der: Uint8Array): Uint8Array => {
    // 0x30 len 0x02 rlen r 0x02 slen s
    let p = 2;
    if (der[1] & 0x80) p = 2 + (der[1] & 0x7f);
    const readInt = () => {
        p++; // 0x02
        let len = der[p++];
        let val = der.slice(p, p + len);
        p += len;
        while (val.length > 32) val = val.slice(1);
        const out = new Uint8Array(32);
        out.set(val, 32 - val.length);
        return out;
    };
    const r = readInt();
    const s = readInt();
    const raw = new Uint8Array(64);
    raw.set(r, 0); raw.set(s, 32);
    return raw;
};

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice().buffer));

describe('base64url', () => {
    it('round-trips bytes', () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
        expect([...b64urlDecode(b64urlEncode(bytes))]).toEqual([...bytes]);
    });
    it('produces url-safe output with no padding', () => {
        const encoded = b64urlEncode(new Uint8Array([255, 255, 255]));
        expect(encoded).not.toMatch(/[+/=]/);
    });
});

describe('rpId validation', () => {
    it('accepts the exact domain and registrable suffixes', async () => {
        const db = makeDb();
        const sub = await PasskeyService.register(db, creationOptions({ rp: { id: 'example.com', name: 'x' } }), 'https://app.example.com', undefined);
        expect(sub.response.errorCode).toBeUndefined();
    });
    it('rejects an unrelated rpId', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ rp: { id: 'evil.com', name: 'x' } }), origin, undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);
    });
    it('rejects an rpId that is a public suffix, private section included', async () => {
        const db = makeDb();
        for (const [rp, from] of [
            ['com', 'https://example.com'],
            ['co.uk', 'https://site.co.uk'],
            ['github.io', 'https://user.github.io'],
        ]) {
            const res = await PasskeyService.register(db, creationOptions({ rp: { id: rp, name: 'x' } }), from, undefined);
            expect(res.response.errorCode, rp).toBe(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);
        }
    });
    it('rejects a suffix of an IP address', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ rp: { id: '3.4', name: 'x' } }), 'https://1.2.3.4', undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);
    });
    it('still accepts a registrable domain under a private suffix', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ rp: { id: 'user.github.io', name: 'x' } }), 'https://app.user.github.io', undefined);
        expect(res.response.errorCode).toBeUndefined();
    });
    it('applies the same check to assertions', async () => {
        const db = makeDb();
        const res = await PasskeyService.allowedEntries(db, { challenge, rpId: 'com', allowCredentials: [] }, origin);
        expect('errorCode' in res && res.errorCode).toBe(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);
    });
    it('rejects non-https non-localhost origins', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions(), 'http://example.com', undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.ORIGIN_NOT_ALLOWED);
    });
});

describe('register validation', () => {
    it('rejects a short challenge', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ challenge: 'short' }), origin, undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.INVALID_CHALLENGE);
    });
    it('rejects an empty user id', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ user: { id: '', name: 'a' } }), origin, undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.INVALID_USER_ID);
    });
    it('rejects when no supported algorithm is offered', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ pubKeyCredParams: [{ type: 'public-key', alg: -999 }] }), origin, undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.NO_SUPPORTED_ALGORITHMS);
    });
});

describe('register stores a compatible entry', () => {
    it('creates a passkey entry with KPEX attributes in the default group', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions(), origin, undefined);
        expect(res.store).toBeDefined();
        res.store!();

        const group = db.getDefaultGroup().groups.find(g => g.name === PASSKEYS_GROUP_NAME)!;
        expect(group).toBeDefined();
        const entry = group.entries[0];
        expect(entry.tags).toContain('Passkey');
        expect(entry.fields.get(PASSKEY_ATTRIBUTES.relyingParty)).toBe(rpId);
        const pem = entry.fields.get(PASSKEY_ATTRIBUTES.privateKeyPem) as kdbxweb.ProtectedValue;
        expect(pem.getText()).toContain('BEGIN PRIVATE KEY');
        const handle = entry.fields.get(PASSKEY_ATTRIBUTES.userHandle) as kdbxweb.ProtectedValue;
        expect(handle.getText()).toBe(userId);
    });

    it('excludes a credential already registered', async () => {
        const db = makeDb();
        const first = await PasskeyService.register(db, creationOptions(), origin, undefined);
        first.store!();
        const credentialId = first.response.id;

        const res = await PasskeyService.register(db, creationOptions({
            excludeCredentials: [{ type: 'public-key', id: credentialId }],
        }), origin, undefined);
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.CREDENTIAL_IS_EXCLUDED);
    });

    it('re-registering the same user handle updates in place with history', async () => {
        const db = makeDb();
        (await PasskeyService.register(db, creationOptions(), origin, undefined)).store!();
        const group = db.getDefaultGroup().groups.find(g => g.name === PASSKEYS_GROUP_NAME)!;
        expect(group.entries).toHaveLength(1);

        (await PasskeyService.register(db, creationOptions(), origin, undefined)).store!();
        expect(group.entries).toHaveLength(1);
        expect(group.entries[0].history.length).toBe(1);
    });
});

describe('assertion round trip', () => {
    it('produces a signature that verifies against the registered public key', async () => {
        const db = makeDb();
        const reg = await PasskeyService.register(db, creationOptions(), origin, undefined);
        reg.store!();

        // recover the public key from the attestation object
        const authData = parseAttestationObject(reg.response.response.attestationObject);
        const { cosePublicKey, credentialId } = parseAuthData(authData);
        const publicKey = await importCoseEcKey(cosePublicKey);

        const allowed = await PasskeyService.allowedEntries(db, {
            challenge,
            rpId,
            allowCredentials: [{ type: 'public-key', id: reg.response.id }],
        }, origin);
        expect('entries' in allowed).toBe(true);
        if (!('entries' in allowed)) return;

        const assertion = await PasskeyService.assert(allowed.entries[0], { challenge, rpId }, origin, rpId);
        expect(assertion.errorCode).toBeUndefined();
        expect(assertion.id).toBe(reg.response.id);

        // verify: signature is over authenticatorData || sha256(clientDataJSON)
        const assertedAuthData = b64urlDecode(assertion.response.authenticatorData);
        const clientDataJson = b64urlDecode(assertion.response.clientDataJSON);
        const signed = new Uint8Array([...assertedAuthData, ...(await sha256(clientDataJson))]);
        const rawSig = derToRaw(b64urlDecode(assertion.response.signature));
        const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' }, publicKey, rawSig.slice().buffer, signed.slice().buffer);
        expect(valid).toBe(true);

        // rpIdHash in the asserted authData must match the RP
        const assertedRpHash = assertedAuthData.slice(0, 32);
        expect([...assertedRpHash]).toEqual([...(await sha256(new TextEncoder().encode(rpId)))]);
        expect([...credentialId]).toEqual([...b64urlDecode(reg.response.id)]);
    });

    it('reports no logins when nothing matches the rp', async () => {
        const db = makeDb();
        const allowed = await PasskeyService.allowedEntries(db, { challenge, rpId, allowCredentials: [] }, origin);
        expect('errorCode' in allowed && allowed.errorCode).toBe(PASSKEY_ERRORS.NO_LOGINS_FOUND);
    });

    it('clientDataJSON records the correct type and origin', async () => {
        const db = makeDb();
        const reg = await PasskeyService.register(db, creationOptions(), origin, undefined);
        reg.store!();
        const created = JSON.parse(new TextDecoder().decode(b64urlDecode(reg.response.response.clientDataJSON)));
        expect(created.type).toBe('webauthn.create');
        expect(created.origin).toBe(origin);
        expect(created.challenge).toBe(challenge);

        const allowed = await PasskeyService.allowedEntries(db, { challenge, rpId, allowCredentials: [{ type: 'public-key', id: reg.response.id }] }, origin);
        if (!('entries' in allowed)) throw new Error('no entries');
        const assertion = await PasskeyService.assert(allowed.entries[0], { challenge, rpId }, origin, rpId);
        const got = JSON.parse(new TextDecoder().decode(b64urlDecode(assertion.response.clientDataJSON)));
        expect(got.type).toBe('webauthn.get');
    });
});

describe('localhost gating', () => {
    it('rejects localhost unless explicitly allowed', async () => {
        const db = makeDb();
        const localOptions = creationOptions({ rp: { id: 'localhost', name: 'x' } });
        const denied = await PasskeyService.register(db, localOptions, 'http://localhost:8080', undefined);
        expect(denied.response.errorCode).toBe(PASSKEY_ERRORS.ORIGIN_NOT_ALLOWED);
        const allowed = await PasskeyService.register(db, localOptions, 'http://localhost:8080', undefined, { allowLocalhost: true });
        expect(allowed.response.errorCode).toBeUndefined();
    });
});

describe('related origins', () => {
    const crossOptions = creationOptions({ rp: { id: 'example.com', name: 'x' } });
    const caller = 'https://app.other-brand.net';

    it('accepts a mismatched rpId when the caller origin is related', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, crossOptions, caller, undefined, {
            relatedOrigins: ['https://example.de', 'https://app.other-brand.net'],
        });
        expect(res.response.errorCode).toBeUndefined();
        expect(res.rpId).toBe('example.com');
    });

    it('still rejects when the caller origin is not in the list', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, crossOptions, caller, undefined, {
            relatedOrigins: ['https://example.de'],
        });
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);
    });

    it('a public suffix rpId is refused whatever the list says', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({ rp: { id: 'com', name: 'x' } }), caller, undefined, {
            relatedOrigins: [caller],
        });
        expect(res.response.errorCode).toBe(PASSKEY_ERRORS.DOMAIN_RPID_MISMATCH);
    });
});

describe('algorithm selection', () => {
    it('honors the RP preference order', async () => {
        expect(await PasskeyService.pickAlgorithm([
            { type: 'public-key', alg: -257 },
            { type: 'public-key', alg: -7 },
        ])).toBe(-257);
        expect(await PasskeyService.pickAlgorithm(undefined)).toBe(-7);
        expect(await PasskeyService.pickAlgorithm([{ type: 'public-key', alg: -999 }])).toBeNull();
    });

    it('registers an RS256 credential when the RP only offers RSA', async () => {
        const db = makeDb();
        const res = await PasskeyService.register(db, creationOptions({
            pubKeyCredParams: [{ type: 'public-key', alg: -257 }],
        }), origin, undefined);
        expect(res.response.errorCode).toBeUndefined();
        expect(res.response.response.publicKeyAlgorithm).toBe(-257);
    });
});

describe('ui helpers', () => {
    it('summarizes a passkey from custom fields and hides its keys', async () => {
        const db = makeDb();
        (await PasskeyService.register(db, creationOptions(), origin, undefined)).store!();
        const entry = db.getDefaultGroup().groups.find(g => g.name === PASSKEYS_GROUP_NAME)!.entries[0];
        const fields = [...entry.fields]
            .filter(([key]) => !['Title', 'UserName', 'Password', 'URL', 'Notes'].includes(key))
            .map(([key, value]) => ({ key, value }));
        const info = PasskeyService.passkeyFromFields(fields);
        expect(info).toEqual({ relyingParty: rpId, username: 'alice' });
        expect(PasskeyService.isPasskeyFieldKey(PASSKEY_ATTRIBUTES.privateKeyPem)).toBe(true);
        expect(PasskeyService.isPasskeyFieldKey('otp')).toBe(false);
        expect(PasskeyService.passkeyFromFields([{ key: 'other', value: 'x' }])).toBeNull();
    });
});

describe('ecdsaRawToDer', () => {
    it('wraps r||s into a valid DER sequence with high-bit padding', () => {
        const raw = new Uint8Array(64);
        raw[0] = 0x80; // r high bit set -> needs 0x00 pad
        raw[32] = 0x01;
        const der = ecdsaRawToDer(raw);
        expect(der[0]).toBe(0x30);
        expect(der[2]).toBe(0x02);
        // r integer body starts with 0x00 because the top bit was set
        expect(der[4]).toBe(0x00);
    });
});

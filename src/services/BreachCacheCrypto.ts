import * as kdbxweb from 'kdbxweb';
import nacl from 'tweetnacl';

// The breach caches hold the security posture of a vault: which entries are
// weak or breached, and the email addresses they were checked under. That is
// a target list, and it used to sit in localStorage in the clear, next to an
// encrypted file whose whole job is to keep exactly that private. Everything
// written from here is sealed instead, under a key that only an open vault
// can produce.
//
// The key comes from the root group's UUID. That value lives inside the
// encrypted XML, so reading it at all means the vault was already opened, and
// it is stable for the life of the database, so the cache survives a master
// password change.
//
// Deriving from the master password hash instead would be a mistake worth
// spelling out. credentials.getHash() is the pre-KDF composite key, so
// anything derived from it cheaply is an offline oracle: guess a password,
// derive, try to open a cache blob, and a success confirms the guess without
// ever paying the Argon2 cost the database itself imposes. That would make
// this cache a faster way to attack the vault than the vault. No password
// material is involved here for that reason.
//
// A single domain separated hash is the whole KDF because the input is
// already a uniformly random 122 bit value rather than a guessable secret.
// SHA-256 of that UUID is handed to browser extensions as the database hash,
// which is why the derivations below hash the raw UUID under their own labels
// rather than reusing that value.

const KEY_LABEL = 'vigil-breach-cache-v1';
const ID_LABEL = 'vigil-breach-cache-id-v1';

// Written by earlier versions in the clear; removed on sight
const LEGACY_KEYS = ['breach_status_store', 'email_breach_status_store'];

export const CACHE_KEY_PREFIX = 'vigil_cache_';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
};

const toHex = (bytes: Uint8Array): string =>
    [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

// Chunked: spreading the whole array into fromCharCode overflows the call
// stack past ~125 KB, and a large vault's cache blob is bigger than that
const toBase64 = (bytes: Uint8Array): string => {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array =>
    Uint8Array.from(atob(text), c => c.charCodeAt(0));

interface CacheIdentity {
    // Seals the blob
    key: Uint8Array;
    // Names it, so no database path appears in storage either
    id: string;
}

class BreachCacheCryptoImpl {
    private identity: CacheIdentity | null = null;
    // Bumped on every unlock and lock. The stores compare it against their
    // own copy and reload, so a vault opening or closing never leaves them
    // serving another vault's decrypted contents
    private currentEpoch = 0;

    get epoch(): number {
        return this.currentEpoch;
    }

    get isUnlocked(): boolean {
        return this.identity !== null;
    }

    // Synchronous on purpose. The breach sweep starts as soon as a vault
    // opens and the stores are read during render, so a key that arrived a
    // microtask later would turn every unlock into a full re-check
    unlock(kdbxDb: kdbxweb.Kdbx): void {
        const uuid = kdbxweb.ByteUtils.base64ToBytes(kdbxDb.getDefaultGroup().uuid.id);
        this.identity = {
            key: nacl.hash(concat(utf8(KEY_LABEL), uuid)).slice(0, nacl.secretbox.keyLength),
            id: toHex(nacl.hash(concat(utf8(ID_LABEL), uuid)).slice(0, 16)),
        };
        this.currentEpoch++;
    }

    lock(): void {
        this.identity?.key.fill(0);
        this.identity = null;
        this.currentEpoch++;
    }

    private storageKey(name: string): string | null {
        return this.identity ? `${CACHE_KEY_PREFIX}${name}_${this.identity.id}` : null;
    }

    // Returns null whenever the cache cannot be read: no vault open, nothing
    // stored, or a blob this key does not open. Callers treat that as a cold
    // cache and check again, which is the safe direction to fail in
    read<T>(name: string): T | null {
        const storageKey = this.storageKey(name);
        if (!storageKey || !this.identity) return null;
        try {
            const stored = localStorage.getItem(storageKey);
            if (!stored) return null;
            const raw = fromBase64(stored);
            const nonce = raw.subarray(0, nacl.secretbox.nonceLength);
            const box = raw.subarray(nacl.secretbox.nonceLength);
            const opened = nacl.secretbox.open(box, nonce, this.identity.key);
            if (!opened) return null;
            return JSON.parse(new TextDecoder().decode(opened)) as T;
        } catch {
            return null;
        }
    }

    write(name: string, value: unknown): void {
        const storageKey = this.storageKey(name);
        if (!storageKey || !this.identity) return;
        try {
            const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
            const box = nacl.secretbox(utf8(JSON.stringify(value)), nonce, this.identity.key);
            localStorage.setItem(storageKey, toBase64(concat(nonce, box)));
        } catch { /* storage full or unavailable; the cache is rebuildable */ }
    }

    remove(name: string): void {
        const storageKey = this.storageKey(name);
        if (!storageKey) return;
        try {
            localStorage.removeItem(storageKey);
        } catch { /* storage unavailable */ }
    }

    // "Clear cache" in settings means every vault this machine has cached,
    // not just the one currently open. Scoped to one store's own blobs, so
    // clearing the password cache does not take the email cache with it
    removeAllFor(name: string): void {
        try {
            const prefix = `${CACHE_KEY_PREFIX}${name}_`;
            Object.keys(localStorage)
                .filter(key => key.startsWith(prefix))
                .forEach(key => localStorage.removeItem(key));
        } catch { /* storage unavailable */ }
    }

    // Drop anything an earlier version wrote in the clear. Costs one re-sweep
    purgeLegacyPlaintext(): void {
        try {
            LEGACY_KEYS.forEach(key => localStorage.removeItem(key));
        } catch { /* storage unavailable */ }
    }
}

export const BreachCacheCrypto = new BreachCacheCryptoImpl();

// On load rather than on unlock, so the plaintext goes away on the next
// launch even if no vault is ever opened again
if (typeof localStorage !== 'undefined') {
    BreachCacheCrypto.purgeLegacyPlaintext();
}

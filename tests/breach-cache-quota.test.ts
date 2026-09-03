import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { cred } from './helpers';

// localStorage gives an origin 5-10 MB. A large vault's sealed breach blob
// can blow past that, and a write that fails silently means every unlock
// re-sweeps the whole vault against HIBP with no signal to the user. These
// tests pin the recovery: evict other vaults' blobs and retry, and if the
// write still fails, say so once.

let quota = Infinity;
let alwaysFail = false;

// Methods live on the prototype, so Object.keys returns only the stored
// entries, the way a real Storage behaves and the way eviction enumerates
class FakeStorage {
    getItem(key: string): string | null {
        return Object.prototype.hasOwnProperty.call(this, key) ? (this as any)[key] : null;
    }
    setItem(key: string, value: string): void {
        if (alwaysFail) throw new DOMException('quota exceeded', 'QuotaExceededError');
        const incoming = String(value);
        const used = Object.keys(this).reduce(
            (total, k) => (k === key ? total : total + ((this as any)[k] as string).length), 0);
        if (used + incoming.length > quota) {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
        }
        (this as any)[key] = incoming;
    }
    removeItem(key: string): void {
        delete (this as any)[key];
    }
}

const store = new FakeStorage();
const keys = (): string[] => Object.keys(store);
const usedBytes = (): number => keys().reduce((total, k) => total + (store.getItem(k) as string).length, 0);
const clearStore = () => keys().forEach(key => store.removeItem(key));

const toast = vi.fn();
vi.stubGlobal('localStorage', store);
vi.stubGlobal('window', { showToast: toast });

const { BreachCacheCrypto, CACHE_KEY_PREFIX } = await import('../src/services/BreachCacheCrypto');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');

const makeVault = async (name: string) => {
    const db = kdbxweb.Kdbx.create(cred(), name);
    db.setVersion(3);
    return await kdbxweb.Kdbx.load(await db.save(), cred());
};

const VAULT_PATH = '/home/someone/vault.kdbx';
const STATUS = { isPwned: true, count: 12, strength: null };

beforeEach(() => {
    quota = Infinity;
    alwaysFail = false;
    clearStore();
    BreachCacheCrypto.lock();
    BreachStatusStore.clearAll();
    clearStore();
    toast.mockClear();
});

describe('breach cache under storage quota pressure', () => {
    it('evicts other vaults blobs and retries when the first write hits quota', async () => {
        // Another vault's stale cache already occupies storage
        const other = await makeVault('Other');
        BreachCacheCrypto.unlock(other);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'stale-entry', STATUS);
        BreachStatusStore.flush();
        BreachCacheCrypto.lock();
        const otherKeys = keys().filter(k => k.startsWith(CACHE_KEY_PREFIX));
        expect(otherKeys).toHaveLength(1);

        // Both blobs together exceed quota; either alone fits (the payloads
        // are the same size, and 10 bytes of slack covers the difference)
        quota = usedBytes() + 10;

        const mine = await makeVault('Mine');
        BreachCacheCrypto.unlock(mine);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', STATUS);
        BreachStatusStore.flush();

        // The other vault's blob was evicted and the retry landed
        expect(store.getItem(otherKeys[0])).toBeNull();
        expect(keys().filter(k => k.startsWith(CACHE_KEY_PREFIX))).toHaveLength(1);

        // The open vault's data actually persisted: a fresh unlock reads it
        quota = Infinity;
        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(mine);
        expect(BreachStatusStore.getEntryStatus(VAULT_PATH, 'entry-1')).toMatchObject({
            isPwned: true, count: 12,
        });

        // Recovery worked, so the user hears nothing
        expect(toast).not.toHaveBeenCalled();
    });

    it('warns exactly once per session when writes keep failing, and never throws', async () => {
        BreachCacheCrypto.unlock(await makeVault('Vault'));
        alwaysFail = true;

        // Coalesced writes fire repeatedly during a sweep; each one fails
        for (let i = 0; i < 5; i++) {
            BreachStatusStore.setEntryStatus(VAULT_PATH, `entry-${i}`, STATUS);
            expect(() => BreachStatusStore.flush()).not.toThrow();
        }

        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
        const { message } = toast.mock.calls[0][0];
        expect(message.toLowerCase()).toContain('breach');
    });
});

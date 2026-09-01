import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { cred } from './helpers';

// The breach caches describe which entries are weak or breached and the email
// addresses they were checked under. Stored in the clear that is a target list
// sitting next to an encrypted vault, readable with no credentials at all.
// Methods live on the prototype, so Object.keys returns only the stored
// entries, the way a real Storage behaves and the way removeAll expects
class FakeStorage {
    getItem(key: string): string | null {
        return Object.prototype.hasOwnProperty.call(this, key) ? (this as any)[key] : null;
    }
    setItem(key: string, value: string): void {
        (this as any)[key] = String(value);
    }
    removeItem(key: string): void {
        delete (this as any)[key];
    }
}

const store = new FakeStorage();
const keys = (): string[] => Object.keys(store);
const clearStore = () => keys().forEach(key => store.removeItem(key));

vi.stubGlobal('localStorage', store);

const { BreachCacheCrypto, CACHE_KEY_PREFIX } = await import('../src/services/BreachCacheCrypto');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');
const { EmailBreachStatusStore } = await import('../src/services/EmailBreachStatusStore');

const makeVault = async (name: string) => {
    const db = kdbxweb.Kdbx.create(cred(), name);
    db.setVersion(3);
    return await kdbxweb.Kdbx.load(await db.save(), cred());
};

const everythingStored = () => keys().map(key => `${key}=${store.getItem(key)}`).join('\n');

const VAULT_PATH = '/home/someone/vault.kdbx';
const EMAIL = 'someone@example.com';

beforeEach(() => {
    clearStore();
    BreachCacheCrypto.lock();
    BreachStatusStore.clearAll();
    EmailBreachStatusStore.clearAll();
    clearStore();
});

describe('breach cache at rest', () => {
    it('leaves no email address or vault path readable in storage', async () => {
        BreachCacheCrypto.unlock(await makeVault('Vault'));

        EmailBreachStatusStore.setEntryEmailStatus(VAULT_PATH, 'entry-1', EMAIL, [
            { Name: 'Acme', Title: 'Acme', Domain: 'acme.com' } as any,
        ]);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', {
            isPwned: true, count: 12, strength: null,
        });
        EmailBreachStatusStore.flush();
        BreachStatusStore.flush();

        const dump = everythingStored();
        expect(dump).not.toContain(EMAIL);
        expect(dump).not.toContain('example.com');
        expect(dump).not.toContain(VAULT_PATH);
        expect(dump).not.toContain('vault.kdbx');
        expect(dump).not.toContain('entry-1');
        expect(dump).not.toContain('Acme');
        // Something was actually written, so the assertions above are not
        // passing because nothing happened
        expect(keys().length).toBeGreaterThan(0);
    });

    it('reads its own cache back once the same vault is open', async () => {
        const vault = await makeVault('Vault');
        BreachCacheCrypto.unlock(vault);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', {
            isPwned: true, count: 12, strength: null,
        });
        BreachStatusStore.flush();

        // A fresh unlock of the same vault, as on the next launch
        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(vault);

        expect(BreachStatusStore.getEntryStatus(VAULT_PATH, 'entry-1')).toMatchObject({
            isPwned: true, count: 12,
        });
    });

    it('reads as a cold cache while no vault is open', async () => {
        const vault = await makeVault('Vault');
        BreachCacheCrypto.unlock(vault);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', {
            isPwned: true, count: 12, strength: null,
        });
        BreachStatusStore.flush();
        BreachCacheCrypto.lock();

        expect(BreachStatusStore.getEntryStatus(VAULT_PATH, 'entry-1')).toBeNull();
    });

    it('does not let one vault read another vault cache', async () => {
        const mine = await makeVault('Mine');
        const theirs = await makeVault('Theirs');

        BreachCacheCrypto.unlock(mine);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', {
            isPwned: true, count: 12, strength: null,
        });
        BreachStatusStore.flush();

        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(theirs);
        expect(BreachStatusStore.getEntryStatus(VAULT_PATH, 'entry-1')).toBeNull();
    });

    it('survives a master password change', async () => {
        const vault = await makeVault('Vault');
        BreachCacheCrypto.unlock(vault);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', {
            isPwned: true, count: 12, strength: null,
        });
        BreachStatusStore.flush();

        // The key comes from the root group uuid, not from password material,
        // so rotating the master password does not throw the cache away
        await vault.credentials.setPassword(kdbxweb.ProtectedValue.fromString('a new one'));
        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(vault);

        expect(BreachStatusStore.getEntryStatus(VAULT_PATH, 'entry-1')).toMatchObject({ count: 12 });
    });

    it('treats a corrupted blob as a cold cache instead of throwing', async () => {
        const vault = await makeVault('Vault');
        BreachCacheCrypto.unlock(vault);
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'entry-1', {
            isPwned: true, count: 12, strength: null,
        });
        BreachStatusStore.flush();

        for (const key of keys()) store.setItem(key, 'not base64 at all');
        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(vault);

        expect(BreachStatusStore.getEntryStatus(VAULT_PATH, 'entry-1')).toBeNull();
    });

    it('purges anything an older version wrote in the clear', () => {
        store.setItem('breach_status_store', '{"/vault.kdbx":{}}');
        store.setItem('email_breach_status_store', `{"/vault.kdbx":{"emails":{"${EMAIL}":{}}}}`);

        BreachCacheCrypto.purgeLegacyPlaintext();

        expect(store.getItem('breach_status_store')).toBeNull();
        expect(store.getItem('email_breach_status_store')).toBeNull();
    });

    it('clears every cached vault, not just the open one', async () => {
        BreachCacheCrypto.unlock(await makeVault('One'));
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'e', { isPwned: false, count: 0, strength: null });
        BreachStatusStore.flush();

        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(await makeVault('Two'));
        BreachStatusStore.setEntryStatus(VAULT_PATH, 'e', { isPwned: false, count: 0, strength: null });
        BreachStatusStore.flush();
        expect(keys().filter(k => k.startsWith(CACHE_KEY_PREFIX))).toHaveLength(2);

        BreachStatusStore.clearAll();
        expect(keys().filter(k => k.startsWith(CACHE_KEY_PREFIX))).toHaveLength(0);
    });
});

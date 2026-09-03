import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, MockEnv } from './helpers';

// A cached breach/strength verdict is about one specific password. Saving a
// different password for the entry must drop the verdict, or the status (up
// to its 24h TTL) keeps flagging a rotated password as breached, and keeps
// calling a weakened password strong.

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
};

const env: MockEnv = installMockWindow();
void env;
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');

const DB_PATH = '/vaults/status.kdbx';

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const entry = db0.createEntry(db0.getDefaultGroup());
    entry.fields.set('Title', 'Entry');
    entry.fields.set('UserName', 'user');
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

const breachedStatus = {
    isPwned: true,
    count: 7,
    strength: { score: 0, feedback: { warning: '', suggestions: [] } },
};

beforeEach(() => {
    store.clear();
    Svc.setPath(DB_PATH);
});

describe('saving with a changed password', () => {
    it('drops the entry\'s cached verdict', async () => {
        const db = await makeDb();
        const database = Svc.convertKdbxToDatabase(db);
        const entry = database.root.entries[0];
        BreachStatusStore.setEntryStatus(DB_PATH, entry.id, breachedStatus);

        const edited = { ...entry, password: 'rotated', modified: new Date() };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, db);

        expect(BreachStatusStore.getEntryStatus(DB_PATH, entry.id)).toBeNull();
    });

    it('keeps the verdict when only another field changed', async () => {
        const db = await makeDb();
        const database = Svc.convertKdbxToDatabase(db);
        const entry = database.root.entries[0];
        BreachStatusStore.setEntryStatus(DB_PATH, entry.id, breachedStatus);

        const edited = { ...entry, title: 'Renamed', modified: new Date() };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, db);

        expect(BreachStatusStore.getEntryStatus(DB_PATH, entry.id)?.isPwned).toBe(true);
    });

    it('keeps other entries\' verdicts when one password rotates', async () => {
        const db = await makeDb();
        const other = db.createEntry(db.getDefaultGroup());
        other.fields.set('Title', 'Other');
        other.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw2'));
        const reloaded = await kdbxweb.Kdbx.load(await db.save(), cred());

        const database = Svc.convertKdbxToDatabase(reloaded);
        const [first, second] = database.root.entries;
        BreachStatusStore.setEntryStatus(DB_PATH, first.id, breachedStatus);
        BreachStatusStore.setEntryStatus(DB_PATH, second.id, breachedStatus);

        const edited = { ...first, password: 'rotated', modified: new Date() };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, reloaded);

        expect(BreachStatusStore.getEntryStatus(DB_PATH, first.id)).toBeNull();
        expect(BreachStatusStore.getEntryStatus(DB_PATH, second.id)?.isPwned).toBe(true);
    });
});

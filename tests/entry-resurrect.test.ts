import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

// An entry can vanish from the model while its editor is open: a merge from
// another replica deleted it. Saving the edit used to return the database
// unchanged and still report success, silently dropping the user's work. The
// open editor is the newer intent: the save re-adds the entry (same id, so
// KDBX merge rules keep it over the tombstone) and says so.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const work = db0.createGroup(db0.getDefaultGroup(), 'Work');
    const site = db0.createEntry(work);
    site.fields.set('Title', 'Site');
    site.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

let kdbxDb: kdbxweb.Kdbx;
beforeEach(async () => {
    kdbxDb = await makeDb();
});

describe('saving an entry deleted from the model meanwhile', () => {
    it('re-adds the edit to the selected group with its original id', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const site = work.entries[0];

        // The deletion another replica's merge applied while editing
        const withoutSite = {
            ...database,
            root: {
                ...database.root,
                groups: database.root.groups.map(g =>
                    g.name === 'Work' ? { ...g, entries: [] } : g),
            },
        };

        const edited = { ...site, username: 'typed-while-deleting', modified: new Date() };
        const [updated, savedEntry, resurrected] = Svc.saveEntry(withoutSite, edited, work, false);

        expect(resurrected).toBe(true);
        expect(savedEntry.id).toBe(site.id);
        const updatedWork = updated.root.groups.find(g => g.name === 'Work')!;
        expect(updatedWork.entries.map(e => e.id)).toEqual([site.id]);
        expect(updatedWork.entries[0].username).toBe('typed-while-deleting');
    });

    it('lands at the root when the selected group is gone too', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const site = work.entries[0];
        const emptied = { ...database, root: { ...database.root, groups: [] } };

        const [updated, savedEntry, resurrected] = Svc.saveEntry(emptied, { ...site }, work, false);

        expect(resurrected).toBe(true);
        expect(updated.root.entries.map(e => e.id)).toContain(savedEntry.id);
    });

    it('writes the resurrected entry back into the kdbx under the same uuid', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const site = work.entries[0];

        // Delete it from the kdbx too, as a real merge would have
        const kdbxWork = [...kdbxDb.getDefaultGroup().allGroups()].find(g => g.name === 'Work')!;
        kdbxDb.remove(kdbxWork.entries[0]);

        const withoutSite = {
            ...database,
            root: {
                ...database.root,
                groups: database.root.groups.map(g =>
                    g.name === 'Work' ? { ...g, entries: [] } : g),
            },
        };
        const [updated, , resurrected] = Svc.saveEntry(withoutSite, { ...site, username: 'back' }, work, false);
        expect(resurrected).toBe(true);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const entries = [...reloaded.getDefaultGroup().allGroups()].find(g => g.name === 'Work')!.entries;
        expect(entries).toHaveLength(1);
        expect(entries[0].uuid.toString()).toBe(site.id);
        expect(entries[0].fields.get('UserName')).toBe('back');
    });

    it('a normal update neither resurrects nor duplicates', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const site = work.entries[0];

        const [updated, , resurrected] = Svc.saveEntry(database, { ...site, username: 'edited' }, work, false);

        expect(resurrected).toBe(false);
        const updatedWork = updated.root.groups.find(g => g.name === 'Work')!;
        expect(updatedWork.entries).toHaveLength(1);
    });
});

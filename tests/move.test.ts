import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const groupNamed = (db: kdbxweb.Kdbx, name: string) =>
    [...db.getDefaultGroup().allGroups()].find(g => g.name === name)!;

// An entry or a group that moves keeps its identity in the kdbx: same object,
// so history, tags and everything else the model does not carry survive, and
// the same UUID, so a merge on another replica sees a move rather than a
// delete plus an unrelated insert.
describe('moving objects between groups', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const work = db0.createGroup(db0.getDefaultGroup(), 'Work');
        db0.createGroup(db0.getDefaultGroup(), 'Personal');
        const site = db0.createEntry(work);
        site.fields.set('Title', 'Site');
        site.fields.set('UserName', 'user-v1');
        site.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw-v1'));
        site.tags = ['work', 'Passkey'];
        kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
    });

    it('keeps an entry history, tags and uuid across a move', async () => {
        // One edit, so there is a revision to lose
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        let work = database.root.groups.find(g => g.name === 'Work')!;
        let site = work.entries.find(e => e.title === 'Site')!;
        const originalId = site.id;
        const [edited] = Svc.saveEntry(database, { ...site, username: 'user-v2' }, work, false);
        await Svc.saveDatabase(edited, kdbxDb);
        kdbxDb = await loadSaved(env);
        expect(groupNamed(kdbxDb, 'Work').entries[0].history).toHaveLength(1);

        database = Svc.convertKdbxToDatabase(kdbxDb);
        work = database.root.groups.find(g => g.name === 'Work')!;
        const personal = database.root.groups.find(g => g.name === 'Personal')!;
        site = work.entries.find(e => e.title === 'Site')!;
        await Svc.saveDatabase(Svc.moveEntry(database, site, personal), kdbxDb);
        kdbxDb = await loadSaved(env);

        expect(groupNamed(kdbxDb, 'Work').entries).toHaveLength(0);
        const moved = groupNamed(kdbxDb, 'Personal').entries;
        expect(moved).toHaveLength(1);
        expect(moved[0].uuid.toString()).toBe(originalId);
        expect(moved[0].history).toHaveLength(1);
        expect(moved[0].history[0].fields.get('UserName')).toBe('user-v1');
        expect(moved[0].tags).toEqual(['work', 'Passkey']);
        // No tombstone: the entry moved, it was not deleted
        expect(kdbxDb.deletedObjects.map(d => d.uuid!.toString())).not.toContain(originalId);
    });

    it('keeps a group uuid and its entries history across a move', async () => {
        // Nest Personal (which now holds Site with its history) under Work
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const personal = database.root.groups.find(g => g.name === 'Personal')!;
        const personalId = personal.id;
        const entryId = personal.entries[0].id;

        await Svc.saveDatabase(Svc.moveGroup(database, personal, work), kdbxDb);
        kdbxDb = await loadSaved(env);

        const reWork = groupNamed(kdbxDb, 'Work');
        expect(reWork.groups).toHaveLength(1);
        expect(reWork.groups[0].uuid.toString()).toBe(personalId);
        expect(kdbxDb.getDefaultGroup().groups.map(g => g.name)).not.toContain('Personal');

        const entries = reWork.groups[0].entries;
        expect(entries).toHaveLength(1);
        expect(entries[0].uuid.toString()).toBe(entryId);
        expect(entries[0].history).toHaveLength(1);
        expect(kdbxDb.deletedObjects.map(d => d.uuid!.toString())).not.toContain(personalId);
    });

    it('records exactly one revision when an entry is moved and edited at once', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const site = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const before = site.history.length;
        const liveUsername = site.username;

        const moved = Svc.moveEntry(database, site, work);
        const target = Svc.findGroupInDatabase(work.id, moved.root)!;
        const [edited] = Svc.saveEntry(moved, { ...site, username: 'user-v3' }, target, false);
        await Svc.saveDatabase(edited, kdbxDb);
        kdbxDb = await loadSaved(env);

        expect(groupNamed(kdbxDb, 'Personal').entries).toHaveLength(0);
        const reSite = groupNamed(kdbxDb, 'Work').entries[0];
        // One revision for the edit, none for the move
        expect(reSite.history).toHaveLength(before + 1);
        expect(reSite.history[before].fields.get('UserName')).toBe(liveUsername);
        expect(reSite.fields.get('UserName')).toBe('user-v3');
    });

    it('keeps history through a delete into the recycle bin and a restore', async () => {
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        let entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const entryId = entry.id;
        const revisions = entry.history.length;
        expect(revisions).toBeGreaterThan(0);

        await Svc.saveDatabase(Svc.removeEntry(database, entry), kdbxDb);
        kdbxDb = await loadSaved(env);

        const bin = kdbxDb.getGroup(kdbxDb.meta.recycleBinUuid!)!;
        expect(bin.entries).toHaveLength(1);
        expect(bin.entries[0].history).toHaveLength(revisions);

        // Restore it back out of the bin
        database = Svc.convertKdbxToDatabase(kdbxDb);
        const binGroup = Svc.findRecycleBin(database.root)!;
        entry = binGroup.entries.find(e => e.id === entryId)!;
        const work = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.moveEntry(database, entry, work), kdbxDb);
        kdbxDb = await loadSaved(env);

        const restored = groupNamed(kdbxDb, 'Work').entries;
        expect(restored).toHaveLength(1);
        expect(restored[0].uuid.toString()).toBe(entryId);
        expect(restored[0].history).toHaveLength(revisions);
    });
});

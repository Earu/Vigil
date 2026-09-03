import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv, wireConflictResolver } from './helpers';

// A vault in a synced folder has no master copy: two replicas can delete and
// edit the same object without either seeing the other first. kdbxweb's
// merge lets the deletion win every time, whenever it happened. The rule here
// is KeePass's: an object modified after its deletion was edited on purpose
// and survives, and the tombstone goes.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
wireConflictResolver(Svc, env);

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

async function setup(): Promise<kdbxweb.Kdbx> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const work = db0.createGroup(db0.getDefaultGroup(), 'Work');
    work.times.lastModTime = ago(30);
    for (const title of ['Site', 'Other']) {
        const e = db0.createEntry(work);
        e.fields.set('Title', title);
        e.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
        e.times.lastModTime = ago(30);
    }
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 100;
    const local = await loadSaved(env);
    Svc.setPath('/fake.kdbx');
    await tick();
    return local;
}

// Another replica deletes an object and writes the file. A group deletion
// tombstones its entries as well, as KeePassXC and Vigil's own save do
async function remoteDeletes(title: string, at: Date, group = false) {
    const remote = await loadSaved(env);
    const work = remote.getDefaultGroup().groups.find(g => g.name === 'Work')!;
    const uuids: kdbxweb.KdbxUuid[] = [];
    if (group) {
        uuids.push(work.uuid, ...work.entries.map(e => e.uuid));
        remote.getDefaultGroup().groups = remote.getDefaultGroup().groups.filter(g => g !== work);
    } else {
        const target = work.entries.find(e => e.fields.get('Title') === title)!;
        uuids.push(target.uuid);
        work.entries = work.entries.filter(e => e !== target);
    }
    for (const uuid of uuids) {
        const tomb = new kdbxweb.KdbxDeletedObject();
        tomb.uuid = uuid;
        tomb.deletionTime = at;
        remote.deletedObjects.push(tomb);
    }
    env.disk.bytes = Buffer.from(await remote.save());
    env.disk.mtime += 50;
}

const workGroup = (db: kdbxweb.Kdbx) => db.getDefaultGroup().groups.find(g => g.name === 'Work')!;

const editSite = (database: ReturnType<typeof Svc.convertKdbxToDatabase>, username: string) => {
    const work = database.root.groups.find(g => g.name === 'Work')!;
    const site = work.entries.find(e => e.title === 'Site')!;
    return Svc.saveEntry(database, Svc.prepareEntryForSave({ ...site, username }), work, false)[0];
};

beforeEach(() => {
    env.toasts.length = 0;
    env.confirm.calls = 0;
});

describe('a local edit against a remote deletion', () => {
    it('survives the merging save when made after the deletion', async () => {
        const local = await setup();
        await remoteDeletes('Site', ago(5));

        const updated = editSite(Svc.convertKdbxToDatabase(local), 'typed-now');
        await Svc.saveDatabase(updated, local);

        expect(env.toasts.some(t => /merged/i.test(t))).toBe(true);
        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).toContain('Site');
        const site = workGroup(onDisk).entries.find(e => e.fields.get('Title') === 'Site')!;
        expect(site.fields.get('UserName')).toBe('typed-now');
        // The tombstone is retired with the edit, so no later merge can
        // apply it again
        expect(onDisk.deletedObjects.some(t => t.uuid?.equals(site.uuid))).toBe(false);
    });

    it('loses to a deletion made after the edit', async () => {
        const local = await setup();
        // The edit predates the deletion: the other replica saw it and
        // deleted the entry anyway
        const updated = editSite(Svc.convertKdbxToDatabase(local), 'stale-edit');
        const localSite = workGroup(local).entries.find(e => e.fields.get('Title') === 'Site')!;
        await remoteDeletes('Site', new Date(Date.now() + MINUTE));

        await Svc.saveDatabase(updated, local);

        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).not.toContain('Site');
        expect(allTitles(onDisk)).toContain('Other');
        expect(onDisk.deletedObjects.some(t => t.uuid?.equals(localSite.uuid))).toBe(true);
    });
});

describe('an entry re-created by saveEntry after a merge deleted it', () => {
    it('survives the next merge instead of being deleted again', async () => {
        const local = await setup();
        await remoteDeletes('Site', ago(5));

        // First save: the merge applies the deletion (the model predates the
        // deletion time, nothing kept it)
        let database = Svc.convertKdbxToDatabase(local);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const site = work.entries.find(e => e.title === 'Site')!;
        // Mirror the merge in the model, as the UI would after the toast
        // refreshed it, and hold on to the open editor's copy
        const other = work.entries.find(e => e.title === 'Other')!;
        const [pruned] = Svc.saveEntry(database, Svc.prepareEntryForSave({ ...other, notes: 'unrelated' }), work, false);
        await Svc.saveDatabase(pruned, local);
        expect(allTitles(await loadSaved(env))).not.toContain('Site');

        // The open editor saves its edit: saveEntry re-adds it under the
        // old id
        database = Svc.convertKdbxToDatabase(local);
        const workNow = database.root.groups.find(g => g.name === 'Work')!;
        const [resurrected] = Svc.saveEntry(database, Svc.prepareEntryForSave({ ...site, username: 'kept' }), workNow, false);
        await Svc.saveDatabase(resurrected, local);
        expect(allTitles(await loadSaved(env))).toContain('Site');

        // Another replica writes an unrelated change; the merge that brings
        // it in must not apply the retired tombstone
        const remote = await loadSaved(env);
        const added = remote.createEntry(remote.getDefaultGroup());
        added.fields.set('Title', 'Remote');
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime += 50;

        database = Svc.convertKdbxToDatabase(local);
        const [touched] = Svc.saveEntry(
            database,
            Svc.prepareEntryForSave({ ...database.root.groups.find(g => g.name === 'Work')!.entries.find(e => e.title === 'Other')!, notes: 'again' }),
            database.root.groups.find(g => g.name === 'Work')!, false
        );
        await Svc.saveDatabase(touched, local);

        const titles = allTitles(await loadSaved(env));
        expect(titles).toContain('Site');
        expect(titles).toContain('Remote');
    });
});

describe('a remote group deletion', () => {
    it('keeps the group when an entry inside it was edited after the deletion', async () => {
        const local = await setup();
        await remoteDeletes('Work', ago(5), true);

        const updated = editSite(Svc.convertKdbxToDatabase(local), 'edited-after');
        await Svc.saveDatabase(updated, local);

        const onDisk = await loadSaved(env);
        const work = onDisk.getDefaultGroup().groups.find(g => g.name === 'Work');
        expect(work).toBeDefined();
        expect(work!.entries.map(e => e.fields.get('Title'))).toEqual(['Site']);
    });

    it('applies when nothing inside was touched since', async () => {
        const local = await setup();
        await remoteDeletes('Work', ago(5), true);

        const database = Svc.convertKdbxToDatabase(local);
        const [updated] = Svc.saveEntry(database, Svc.prepareEntryForSave({ title: 'RootEntry' } as any), database.root, true);
        await Svc.saveDatabase(updated, local);

        const onDisk = await loadSaved(env);
        expect(onDisk.getDefaultGroup().groups.find(g => g.name === 'Work')).toBeUndefined();
        expect(allTitles(onDisk)).toEqual(['RootEntry']);
    });
});

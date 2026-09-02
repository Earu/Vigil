import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv } from './helpers';

// A merge from disk adds objects to the kdbx that the UI model applied by the
// same save does not have. When that save fails to write, or another save
// was queued behind it, the next save applies a model built before the merge:
// it used to drop every merged object and record each as a deletion, and the
// tombstone then deleted it on the machine that made the change too

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const tombstones = (db: kdbxweb.Kdbx) => db.deletedObjects.map(d => d.uuid!.toString());

// A fresh vault on disk with one entry, loaded, with the baseline landed
async function freshVault(): Promise<kdbxweb.Kdbx> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 500;
    const db = await loadSaved(env);
    Svc.setPath('/fake.kdbx');
    await tick();
    return db;
}

// Another machine adds an entry at the root and a group with an entry in it
async function remoteAdds(): Promise<void> {
    const remote = await loadSaved(env);
    remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'RemoteEntry');
    const group = remote.createGroup(remote.getDefaultGroup(), 'RemoteGroup');
    remote.createEntry(group).fields.set('Title', 'RemoteChild');
    env.disk.bytes = Buffer.from(await remote.save());
    env.disk.mtime += 50;
}

describe('a model built before a merge', () => {
    it('does not delete what the merge brought in when the merging save failed', async () => {
        const db = await freshVault();
        await remoteAdds();

        const electron = (globalThis as any).window.electron;
        const saveToFile = electron.saveToFile;
        electron.saveToFile = async () => ({ success: false, error: 'EBUSY' });

        const stale = Svc.convertKdbxToDatabase(db);
        const [edited] = Svc.saveEntry(stale, { ...stale.root.entries[0], notes: 'local' }, stale.root, false);
        await expect(Svc.saveDatabase(edited, db)).rejects.toThrow('EBUSY');
        expect(Svc.hasUnseenMergedChanges()).toBe(true);

        // The UI did not refresh; it saves the same pre-merge model again
        electron.saveToFile = saveToFile;
        await Svc.saveDatabase(edited, db);

        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk).sort()).toEqual(['Kept', 'RemoteChild', 'RemoteEntry']);
        expect(onDisk.getDefaultGroup().groups.map(g => g.name)).toContain('RemoteGroup');
        const kept = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Kept')!;
        expect(kept.fields.get('Notes')).toBe('local');
        expect(tombstones(onDisk)).toEqual([]);
    });

    it('does not delete what the merge brought in from a save queued behind it', async () => {
        const db = await freshVault();
        await remoteAdds();

        const electron = (globalThis as any).window.electron;
        const saveToFile = electron.saveToFile;
        electron.saveToFile = async (...args: unknown[]) => { await tick(); return saveToFile(...args); };

        // Both models predate the merge the first save performs
        const stale = Svc.convertKdbxToDatabase(db);
        const [first] = Svc.saveEntry(stale, { ...Svc.createNewEntry(), title: 'First' }, stale.root, true);
        const [second] = Svc.saveEntry(first, { ...Svc.createNewEntry(), title: 'Second' }, first.root, true);
        await Promise.all([Svc.saveDatabase(first, db), Svc.saveDatabase(second, db)]);
        electron.saveToFile = saveToFile;

        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk).sort()).toEqual(['First', 'Kept', 'RemoteChild', 'RemoteEntry', 'Second']);
        expect(tombstones(onDisk)).toEqual([]);
    });

    it('still lets the user delete a merged entry once a model has shown it', async () => {
        const db = await freshVault();
        await remoteAdds();

        const stale = Svc.convertKdbxToDatabase(db);
        await Svc.saveDatabase(stale, db);
        expect(allTitles(await loadSaved(env))).toContain('RemoteEntry');

        // The model the UI holds now carries the merged entry; removing it
        // from that model is a deletion the user chose
        const seen = Svc.convertKdbxToDatabase(db);
        expect(Svc.hasUnseenMergedChanges()).toBe(false);
        const remoteId = seen.root.entries.find(e => e.title === 'RemoteEntry')!.id!;
        const purged = { ...seen, root: { ...seen.root, entries: seen.root.entries.filter(e => e.id !== remoteId) } };
        await Svc.saveDatabase(purged, db);

        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).not.toContain('RemoteEntry');
        expect(tombstones(onDisk)).toContain(remoteId);
    });
});

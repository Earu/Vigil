import { describe, it, expect, afterEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, tick, MockEnv, wireConflictResolver } from './helpers';

// mergeExternalChanges mutates the live kdbxDb (history notes, then the merge
// itself). A merge that throws after grafting objects in leaves the database
// half-merged; unless those objects are registered as unseen they carry no
// protection: the overwrite prompt can persist the half-merged state, and the
// next save from a model that predates the merge drops them and writes
// tombstones, deleting them on the machine that made them.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
wireConflictResolver(Svc, env);

const tombstones = (db: kdbxweb.Kdbx) => db.deletedObjects.map(d => d.uuid!.toString());
const realMerge = kdbxweb.Kdbx.prototype.merge;

afterEach(() => {
    kdbxweb.Kdbx.prototype.merge = realMerge;
});

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

async function remoteAdds(): Promise<void> {
    const remote = await loadSaved(env);
    remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'RemoteEntry');
    const group = remote.createGroup(remote.getDefaultGroup(), 'RemoteGroup');
    remote.createEntry(group).fields.set('Title', 'RemoteChild');
    env.disk.bytes = Buffer.from(await remote.save());
    env.disk.mtime += 50;
}

describe('a merge that throws part-way', () => {
    it('leaves nothing behind for a later save to tombstone', async () => {
        const db = await freshVault();
        await remoteAdds();

        // Worst case: the graft completes, then the merge dies
        kdbxweb.Kdbx.prototype.merge = function (this: kdbxweb.Kdbx, remote: kdbxweb.Kdbx) {
            realMerge.call(this, remote);
            throw new Error('merge blew up');
        };
        // The user answers the "could not be merged, overwrite?" prompt with yes
        env.confirm.answer = true;
        env.confirm.calls = 0;

        const stale = Svc.convertKdbxToDatabase(db);
        const [edited] = Svc.saveEntry(stale, { ...stale.root.entries[0], notes: 'local' }, stale.root, false);
        await Svc.saveDatabase(edited, db);
        expect(env.confirm.calls).toBe(1);
        kdbxweb.Kdbx.prototype.merge = realMerge;

        // The UI never refreshed; the next save applies the same pre-merge model
        const [editedAgain] = Svc.saveEntry(edited, { ...edited.root.entries[0], notes: 'local 2' }, edited.root, false);
        await Svc.saveDatabase(editedAgain, db);

        // Whatever the failed merge left in memory, the other machine's
        // objects must never be recorded as deletions the user chose: a
        // tombstone here deletes them there on the next sync
        const onDisk = await loadSaved(env);
        expect(tombstones(onDisk)).toEqual([]);
        const kept = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Kept')!;
        expect(kept.fields.get('Notes')).toBe('local 2');
    });

    it('does not write a half-merged state when the user declines the overwrite', async () => {
        const db = await freshVault();
        await remoteAdds();
        const bytesBefore = Buffer.from(env.disk.bytes!);

        kdbxweb.Kdbx.prototype.merge = function (this: kdbxweb.Kdbx, remote: kdbxweb.Kdbx) {
            realMerge.call(this, remote);
            throw new Error('merge blew up');
        };
        env.confirm.answer = false;

        const stale = Svc.convertKdbxToDatabase(db);
        const [edited] = Svc.saveEntry(stale, { ...stale.root.entries[0], notes: 'local' }, stale.root, false);
        await expect(Svc.saveDatabase(edited, db)).rejects.toThrow('SAVE_CANCELLED_CONFLICT');

        // Declining means the file on disk stays exactly as the other machine
        // left it
        expect(Buffer.compare(env.disk.bytes!, bytesBefore)).toBe(0);
    });
});

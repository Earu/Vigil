import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, ab, attachmentBytes, MockEnv } from './helpers';
import { HistoryNotesService } from '../src/services/HistoryNotesService';

// A vault on a sync mount is edited from more than one machine, so the merge
// that runs when the file changed underneath a save is doing real work rather
// than covering an edge case. These are the shapes that turn up in practice.
const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const WEEK = 7 * 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// An established vault: everything in it was last touched a week ago, so a
// conflict is decided by the two edits under test rather than by how recently
// the fixture happened to be built
async function establishedVault(): Promise<kdbxweb.Kdbx> {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const work = db.createGroup(db.getDefaultGroup(), 'Work');
    db.createGroup(db.getDefaultGroup(), 'Personal');
    const site = db.createEntry(work);
    site.fields.set('Title', 'Site');
    site.fields.set('UserName', 'u0');
    site.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw0'));
    site.binaries.set('doc.txt', await db.createBinary(ab('BASE-DOC')));

    const old = new Date(Date.now() - WEEK);
    for (const item of db.getDefaultGroup().allGroupsAndEntries()) {
        item.times.lastModTime = old;
        item.times.locationChanged = old;
    }

    env.disk.bytes = Buffer.from(await db.save());
    env.disk.mtime = 100;
    return await loadSaved(env);
}

// Another machine edits the file and writes it while we hold it open
async function remoteEdit(edit: (db: kdbxweb.Kdbx) => void | Promise<void>): Promise<void> {
    const remote = await loadSaved(env);
    await edit(remote);
    env.disk.bytes = Buffer.from(await remote.save());
    env.disk.mtime += 50;
}

const groupNames = (db: kdbxweb.Kdbx): string[] => [...db.getDefaultGroup().allGroups()].map(g => g.name!);
const findGroup = (db: kdbxweb.Kdbx, name: string) => [...db.getDefaultGroup().allGroups()].find(g => g.name === name);
const theEntry = (db: kdbxweb.Kdbx) => [...db.getDefaultGroup().allEntries()].find(e => e.fields.get('Title') === 'Site')!;

let local: kdbxweb.Kdbx;

beforeEach(async () => {
    local = await establishedVault();
    Svc.setPath('/fake.kdbx');
    await new Promise(resolve => setTimeout(resolve, 20));
    env.toasts.length = 0;
});

describe('merging another machine changes', () => {
    it('keeps the newer of two group renames', async () => {
        await remoteEdit(db => {
            const work = findGroup(db, 'Work')!;
            work.name = 'Remote Name';
            work.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        // This rename happens after the remote one, so it is the one to keep
        const database = Svc.convertKdbxToDatabase(local);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.updateGroupName(database, work, 'Local Name'), local);

        expect(groupNames(await loadSaved(env))).toContain('Local Name');
    });

    it('takes a remote rename when this side did not touch the group', async () => {
        await remoteEdit(db => {
            const work = findGroup(db, 'Work')!;
            work.name = 'Remote Name';
            work.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        // An unrelated local edit, so the group carries no opinion of its own
        const database = Svc.convertKdbxToDatabase(local);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const [updated] = Svc.saveEntry(database, Svc.prepareEntryForSave({ ...entry, notes: 'local note' }), database.root, false);
        await Svc.saveDatabase(updated, local);

        const names = groupNames(await loadSaved(env));
        expect(names).toContain('Remote Name');
        expect(names).not.toContain('Work');
    });

    it('keeps a move made here and a rename made there', async () => {
        await remoteEdit(db => {
            const work = findGroup(db, 'Work')!;
            work.name = 'Remote Name';
            work.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        const database = Svc.convertKdbxToDatabase(local);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        const personal = database.root.groups.find(g => g.name === 'Personal')!;
        await Svc.saveDatabase(Svc.moveGroup(database, work, personal), local);

        // Location is decided separately from the rest of the group, so both
        // edits survive rather than one replacing the other wholesale
        const saved = await loadSaved(env);
        const moved = findGroup(saved, 'Remote Name');
        expect(moved).toBeDefined();
        expect(moved!.parentGroup!.name).toBe('Personal');
    });

    it('keeps an entry moved here and edited there', async () => {
        await remoteEdit(db => {
            const site = theEntry(db);
            site.pushHistory();
            site.fields.set('UserName', 'u-remote');
            site.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        const database = Svc.convertKdbxToDatabase(local);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const personal = database.root.groups.find(g => g.name === 'Personal')!;
        await Svc.saveDatabase(Svc.moveEntry(database, entry, personal), local);

        const saved = await loadSaved(env);
        const site = theEntry(saved);
        expect(site.fields.get('UserName')).toBe('u-remote');
        expect(site.parentGroup!.name).toBe('Personal');
    });

    it('keeps the losing side attachment recoverable in history', async () => {
        await remoteEdit(async db => {
            const site = theEntry(db);
            site.pushHistory();
            site.binaries.set('remote.txt', await db.createBinary(ab('REMOTE-DOC')));
            site.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        const database = Svc.convertKdbxToDatabase(local);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        // Through prepareEntryForSave, as EntryDetails does, so the edit
        // carries the timestamp a merge compares against
        const [updated] = Svc.saveEntry(database, Svc.prepareEntryForSave({
            ...entry,
            attachments: [...entry.attachments, { name: 'local.txt', data: ab('LOCAL-DOC') }],
        }), database.root, false);
        await Svc.saveDatabase(updated, local);

        // An entry is resolved as a whole, so the newer side's file list wins.
        // The other side's file has to stay reachable through history, and the
        // binary pool cleanup on save must not collect it
        const saved = await loadSaved(env);
        const site = theEntry(saved);
        expect([...site.binaries.keys()]).toEqual(['doc.txt', 'local.txt']);

        const withRemote = site.history.find(h => h.binaries.has('remote.txt'));
        expect(withRemote).toBeDefined();
        expect(attachmentBytes(withRemote as unknown as kdbxweb.KdbxEntry, 'remote.txt')?.toString()).toBe('REMOTE-DOC');
    });

    it('keeps history recorded on both sides', async () => {
        await remoteEdit(db => {
            const site = theEntry(db);
            site.pushHistory();
            site.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw-remote'));
            site.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        const database = Svc.convertKdbxToDatabase(local);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const [updated] = Svc.saveEntry(database, Svc.prepareEntryForSave({ ...entry, password: 'pw-local' }), database.root, false);
        await Svc.saveDatabase(updated, local);

        const site = theEntry(await loadSaved(env));
        expect((site.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('pw-local');
        // The remote password is not lost, it is a revision
        const passwords = site.history.map(h => (h.fields.get('Password') as kdbxweb.ProtectedValue).getText());
        expect(passwords).toContain('pw-remote');
        expect(passwords).toContain('pw0');
    });

    it('does not pile up duplicate revisions over many merges', async () => {
        // Both sides archive the same logical state at their own timestamps,
        // so a merge can leave two revisions holding the same values. That is
        // the union working as intended, but if it compounded, retention would
        // evict genuine revisions to make room for copies
        let session = local;
        for (let round = 0; round < 10; round++) {
            await remoteEdit(db => {
                const site = theEntry(db);
                site.pushHistory();
                site.fields.set('UserName', `remote-${round}`);
                site.times.lastModTime = new Date(Date.now() - 1000);
            });

            const database = Svc.convertKdbxToDatabase(session);
            const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
            const [updated] = Svc.saveEntry(database, Svc.prepareEntryForSave({ ...entry, notes: `local-${round}` }), database.root, false);
            await Svc.saveDatabase(updated, session);

            // Reopen each round: kdbxweb tracks which revisions this replica
            // added in memory only, so a long lived object would hide any
            // problem that only shows up across sessions
            session = await loadSaved(env);
            Svc.setPath('/fake.kdbx');
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        const revisions = theEntry(session).history.map(h => String(h.fields.get('Notes') ?? ''));
        const distinct = new Set(revisions);
        expect(revisions.length - distinct.size).toBeLessThanOrEqual(1);
    });

    it('does not resurrect an entry purged here', async () => {
        await remoteEdit(db => {
            const site = theEntry(db);
            site.pushHistory();
            site.fields.set('UserName', 'u-remote');
            site.times.lastModTime = new Date(Date.now() - 5 * MINUTE);
        });

        // Delete into the bin, then empty it: a real deletion, tombstone and all
        let database = Svc.convertKdbxToDatabase(local);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        database = Svc.removeEntry(database, entry);
        await Svc.saveDatabase(Svc.emptyRecycleBin(database), local);

        const saved = await loadSaved(env);
        expect([...saved.getDefaultGroup().allEntries()]).toHaveLength(0);
    });
});

// The merge decides entry history from tombstones kdbxweb keeps in memory,
// because the format has nowhere to write a deleted revision down. kdbxweb
// says to drop them once the state is pushed, on the assumption that every
// replica syncs before it writes. A vault in a synced folder does not work
// that way, so they are kept and pruned instead; see pruneLocalEditState.
describe('the local edit state after a save', () => {
    // An explicit modification time, because kdbx stores times to the second
    // and a test that saves several times inside one second produces
    // revisions the merge cannot tell apart
    async function editAndSave(session: kdbxweb.Kdbx, notes: string, at: Date): Promise<void> {
        const database = Svc.convertKdbxToDatabase(session);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const prepared = { ...Svc.prepareEntryForSave({ ...entry, notes }), modified: at };
        const [updated] = Svc.saveEntry(database, prepared, database.root, false);
        await Svc.saveDatabase(updated, session);
    }

    const revisionNotes = (db: kdbxweb.Kdbx): string[] =>
        theEntry(db).history.map(h => String(h.fields.get('Notes') ?? ''));

    it('keeps a published revision when another machine writes from an older base', async () => {
        // The state the other machine checked out before going offline
        const staleBase = Buffer.from(env.disk.bytes!);

        await editAndSave(local, 'v1', new Date(Date.now() - 30 * MINUTE));
        await editAndSave(local, 'v2', new Date(Date.now() - 20 * MINUTE));
        expect(revisionNotes(local)).toContain('v1');

        // It comes back, edits the copy it has, and its sync client puts that
        // version on top: never having seen v1, its history does not hold it
        env.disk.bytes = staleBase;
        const remote = await loadSaved(env);
        const remoteEntry = theEntry(remote);
        remoteEntry.pushHistory();
        remoteEntry.fields.set('UserName', 'u-remote');
        remoteEntry.times.lastModTime = new Date(Date.now() - 10 * MINUTE);
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime += 50;

        await editAndSave(local, 'v3', new Date(Date.now() - 5 * MINUTE));

        // v1 was published two saves back. Dropping its tombstone on the way
        // would leave the merge reading the gap in the other machine's history
        // as a deletion, and the revision would be gone for good
        expect(revisionNotes(await loadSaved(env))).toContain('v1');
    });

    it('lets a retention change made elsewhere through once ours is written', async () => {
        // History retention is one of the few meta fields the format gives no
        // change date of its own, so the merge settles it from the edit state
        // alone: whoever holds a tombstone keeps their value
        Svc.setHistoryMaxItems(local, 5);
        await editAndSave(local, 'local retention', new Date(Date.now() - 30 * MINUTE));

        await remoteEdit(db => {
            db.meta.historyMaxItems = 20;
        });

        await editAndSave(local, 'after', new Date(Date.now() - 10 * MINUTE));

        expect(local.meta.historyMaxItems).toBe(20);
    });

    it('bounds the tombstones by what retention keeps, not by session length', async () => {
        // The merge scans this list for every revision it looks at, so a note
        // per save for the life of the session would make each conflict cost
        // the whole editing history
        Svc.setHistoryMaxItems(local, 5);
        for (let round = 0; round < 20; round++) {
            await editAndSave(local, `round-${round}`, new Date(Date.now() - (40 - round) * MINUTE));
        }

        expect(theEntry(local).history.length).toBeLessThanOrEqual(5);
        expect(theEntry(local)._editState?.added.length ?? 0).toBeLessThanOrEqual(5);
        expect(theEntry(local)._editState?.deleted ?? []).toHaveLength(0);
    });
});

// The notes above are only in memory, so they cover the session that made
// them and no more. A vault in a synced folder is edited from several
// machines across many sessions, which is where the notes it carries in
// meta.customData do the work; see HistoryNotesService.
describe('history notes carried in the vault', () => {
    async function editAndSave(session: kdbxweb.Kdbx, notes: string, at: Date): Promise<void> {
        const database = Svc.convertKdbxToDatabase(session);
        const entry = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Site')!;
        const prepared = { ...Svc.prepareEntryForSave({ ...entry, notes }), modified: at };
        const [updated] = Svc.saveEntry(database, prepared, database.root, false);
        await Svc.saveDatabase(updated, session);
    }

    // Lock and unlock: a fresh object off the file, wired up the way App does
    async function reopen(): Promise<kdbxweb.Kdbx> {
        const session = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        Svc.restoreHistoryNotes(session);
        await new Promise(resolve => setTimeout(resolve, 20));
        return session;
    }

    // Another machine writes the base it holds straight over the top, which
    // is what a sync client does for a replica that has been offline
    async function overwriteFromBase(base: Buffer, at: Date): Promise<void> {
        env.disk.bytes = base;
        const remote = await loadSaved(env);
        const entry = theEntry(remote);
        entry.pushHistory();
        entry.fields.set('UserName', 'u-remote');
        entry.times.lastModTime = at;
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime += 50;
    }

    const revisionNotes = (db: kdbxweb.Kdbx): string[] =>
        theEntry(db).history.map(h => String(h.fields.get('Notes') ?? ''));

    it('keeps a revision recorded in an earlier session', async () => {
        const staleBase = Buffer.from(env.disk.bytes!);

        await editAndSave(local, 'v1', new Date(Date.now() - 30 * MINUTE));
        await editAndSave(local, 'v2', new Date(Date.now() - 20 * MINUTE));

        // The vault is locked and opened again, so nothing kdbxweb held about
        // v1 is left. Only what the file itself records survives this
        const session = await reopen();
        expect(theEntry(session)._editState?.added ?? []).not.toHaveLength(0);

        await overwriteFromBase(staleBase, new Date(Date.now() - 10 * MINUTE));
        await editAndSave(session, 'v3', new Date(Date.now() - 5 * MINUTE));

        expect(revisionNotes(await loadSaved(env))).toContain('v1');
    });

    it('honours a revision another machine recorded', async () => {
        // The other machine archives a revision and writes it out. Its note
        // travels with the vault under a key of its own
        await remoteEdit(db => {
            const site = theEntry(db);
            site.pushHistory();
            site.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw-remote'));
            site.times.lastModTime = new Date(Date.now() - 30 * MINUTE);
            HistoryNotesService.write(db, 'other-machine');
        });

        const session = await reopen();
        const carried = HistoryNotesService.read(session);
        expect(carried.size).toBeGreaterThan(0);

        // This machine picks it up: the revision is one somebody recorded, so
        // its absence from a third replica is not a deletion
        const recorded = theEntry(session)._editState?.added ?? [];
        expect(recorded).not.toHaveLength(0);
    });

    it('leaves keys written by other replicas alone', async () => {
        await remoteEdit(db => {
            db.meta.customData.set(HistoryNotesService.keyFor('other-machine'), { value: '1;zzz==:abc' });
        });

        await editAndSave(local, 'ours', new Date(Date.now() - 10 * MINUTE));

        const saved = await loadSaved(env);
        expect(saved.meta.customData.get(HistoryNotesService.keyFor('other-machine'))?.value).toBe('1;zzz==:abc');
    });
});

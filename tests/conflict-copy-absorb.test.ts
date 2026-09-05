import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import crypto from 'crypto';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv, wireConflictResolver } from './helpers';

// A file beside the vault was nominated by name as a sync client's conflict
// copy. absorbConflictCopy decides: it must open under the vault's own
// credentials and be the same database before anything is merged, and the
// same content is never examined twice in a session.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
wireConflictResolver(Svc, env);

const electron = () => (globalThis as any).window.electron;
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

// The mock disk holds one file; conflict copies are served by path from here
const copies = new Map<string, Buffer>();
const baseReadFile = electron().readFile;
electron().readFile = async (path: string) => {
    const copy = copies.get(path);
    if (copy) return { success: true, data: new Uint8Array(copy) };
    if (path.startsWith('/copies/')) return { success: false, error: 'Failed to read file' };
    return baseReadFile(path);
};

async function writeVault(): Promise<void> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 500;
}

async function openVault(): Promise<kdbxweb.Kdbx> {
    const db = await loadSaved(env);
    Svc.setPath('/fake.kdbx', new Uint8Array(env.disk.bytes!));
    await tick();
    return db;
}

// The same database, edited elsewhere and dropped beside the vault by the
// sync client under a conflict name
async function conflictCopy(name: string, title: string): Promise<{ path: string; hash: string }> {
    const remote = await loadSaved(env);
    remote.createEntry(remote.getDefaultGroup()).fields.set('Title', title);
    const bytes = Buffer.from(await remote.save());
    const path = `/copies/${name}`;
    copies.set(path, bytes);
    return { path, hash: sha256(bytes) };
}

beforeEach(() => {
    env.toasts.length = 0;
    env.confirm.calls = 0;
    env.confirm.answer = true;
    env.lastBackup = undefined;
    copies.clear();
    Svc.setPath(undefined);
});

describe('a copy of this vault', () => {
    it('is merged into the open vault, silently', async () => {
        await writeVault();
        const db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');

        expect((await Svc.absorbConflictCopy(db, copy.path, copy.hash)).outcome).toBe('merged');
        expect(allTitles(db)).toEqual(expect.arrayContaining(['Kept', 'FromPhone']));
        // The caller decides what to tell the user; the disk-change toast is
        // for the other path
        expect(env.toasts).toEqual([]);
    });

    it('lands in the file on the next save', async () => {
        await writeVault();
        const db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');
        await Svc.absorbConflictCopy(db, copy.path, copy.hash);

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);
        expect(allTitles(await loadSaved(env))).toEqual(expect.arrayContaining(['Kept', 'FromPhone']));
    });

    it('is examined once per content, however many times it is reported', async () => {
        await writeVault();
        const db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');

        expect((await Svc.absorbConflictCopy(db, copy.path, copy.hash)).outcome).toBe('merged');
        expect((await Svc.absorbConflictCopy(db, copy.path, copy.hash)).outcome).toBe('seen');
        // Changed content is a new nomination
        const again = await conflictCopy('vault 2.kdbx', 'FromTablet');
        expect((await Svc.absorbConflictCopy(db, again.path, again.hash)).outcome).toBe('merged');
        expect(allTitles(db)).toEqual(expect.arrayContaining(['Kept', 'FromPhone', 'FromTablet']));
    });

    it('is examined again after a lock and unlock', async () => {
        await writeVault();
        let db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');
        expect((await Svc.absorbConflictCopy(db, copy.path, copy.hash)).outcome).toBe('merged');

        Svc.setPath(undefined);
        db = await openVault();
        expect((await Svc.absorbConflictCopy(db, copy.path, copy.hash)).outcome).toBe('merged');
    });
});

describe('what the merge reports', () => {
    const outcome = async (db: kdbxweb.Kdbx, copy: { path: string; hash: string }) => {
        const result = await Svc.absorbConflictCopy(db, copy.path, copy.hash);
        expect(result.outcome).toBe('merged');
        return (result as { outcome: 'merged'; changes: { added: number; updated: number; removed: number; groups: number } }).changes;
    };

    it('counts an entry the copy added', async () => {
        await writeVault();
        const db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');
        expect(await outcome(db, copy)).toEqual({ added: 1, updated: 0, removed: 0, groups: 0 });
    });

    it('counts an entry the copy edited more recently', async () => {
        await writeVault();
        const db = await openVault();
        const remote = await loadSaved(env);
        const entry = remote.getDefaultGroup().entries[0];
        entry.pushHistory();
        entry.fields.set('Title', 'Kept, renamed on the phone');
        entry.times.lastModTime = new Date(Date.now() + 60_000);
        const bytes = Buffer.from(await remote.save());
        copies.set('/copies/vault 2.kdbx', bytes);

        expect(await outcome(db, { path: '/copies/vault 2.kdbx', hash: sha256(bytes) })).toEqual({ added: 0, updated: 1, removed: 0, groups: 0 });
        expect(allTitles(db)).toEqual(['Kept, renamed on the phone']);
    });

    it('counts an entry the copy deleted after the vault last touched it', async () => {
        await writeVault();
        const db = await openVault();
        const remote = await loadSaved(env);
        const entry = remote.getDefaultGroup().entries[0];
        // A permanent deletion, not a move to the recycle bin
        remote.meta.recycleBinEnabled = false;
        remote.remove(entry);
        // The vault's copy was last touched at creation; the deletion is later
        for (const tomb of remote.deletedObjects) tomb.deletionTime = new Date(Date.now() + 60_000);
        const bytes = Buffer.from(await remote.save());
        copies.set('/copies/vault 2.kdbx', bytes);

        expect(await outcome(db, { path: '/copies/vault 2.kdbx', hash: sha256(bytes) })).toEqual({ added: 0, updated: 0, removed: 1, groups: 0 });
        expect(allTitles(db)).toEqual([]);
    });

    it('counts an entry the copy moved to its recycle bin as updated', async () => {
        await writeVault();
        const db = await openVault();
        const remote = await loadSaved(env);
        const entry = remote.getDefaultGroup().entries[0];
        remote.remove(entry);
        // kdbx 3 keeps times to the second; the move must read as later than
        // the vault's own location time for the merge to honour it
        entry.times.locationChanged = new Date(Date.now() + 60_000);
        const bytes = Buffer.from(await remote.save());
        copies.set('/copies/vault 2.kdbx', bytes);

        // A new vault already carries a recycle bin group, so the only change
        // is the entry's location
        expect(await outcome(db, { path: '/copies/vault 2.kdbx', hash: sha256(bytes) })).toEqual({ added: 0, updated: 1, removed: 0, groups: 0 });
    });

    it('reports nothing for a copy the vault has already outgrown', async () => {
        await writeVault();
        // The copy is the vault as it was before a local edit
        const stale = Buffer.from(env.disk.bytes!);
        const db = await openVault();
        const model = Svc.convertKdbxToDatabase(db);
        const [edited] = Svc.saveEntry(model, { ...model.root.entries[0], notes: 'newer here' }, model.root, false);
        await Svc.saveDatabase(edited, db);
        copies.set('/copies/vault 2.kdbx', stale);

        expect(await outcome(db, { path: '/copies/vault 2.kdbx', hash: sha256(stale) })).toEqual({ added: 0, updated: 0, removed: 0, groups: 0 });
        const notes = Svc.convertKdbxToDatabase(db).root.entries[0].notes;
        expect(notes).toBe('newer here');
    });
});

describe('what the merge reports, for groups', () => {
    it('counts a new folder separately from entries', async () => {
        await writeVault();
        const db = await openVault();
        const remote = await loadSaved(env);
        remote.createGroup(remote.getDefaultGroup(), 'Work');
        const bytes = Buffer.from(await remote.save());
        copies.set('/copies/vault 2.kdbx', bytes);

        const result = await Svc.absorbConflictCopy(db, '/copies/vault 2.kdbx', sha256(bytes));
        expect(result).toEqual({ outcome: 'merged', changes: { added: 0, updated: 0, removed: 0, groups: 1 } });
    });
});

describe('a file that only carries the name', () => {
    it('another vault under the same password is foreign and untouched', async () => {
        await writeVault();
        const db = await openVault();
        const other = kdbxweb.Kdbx.create(cred(), 'Other');
        other.setVersion(3);
        other.createEntry(other.getDefaultGroup()).fields.set('Title', 'NotMine');
        const bytes = Buffer.from(await other.save());
        copies.set('/copies/vault 2.kdbx', bytes);

        expect((await Svc.absorbConflictCopy(db, '/copies/vault 2.kdbx', sha256(bytes))).outcome).toBe('foreign');
        expect(allTitles(db)).toEqual(['Kept']);
    });

    it('a copy that does not open with these credentials is reported as locked', async () => {
        await writeVault();
        const db = await openVault();
        const rekeyed = await loadSaved(env);
        await rekeyed.credentials.setPassword(kdbxweb.ProtectedValue.fromString('rotated'));
        const bytes = Buffer.from(await rekeyed.save());
        copies.set('/copies/vault 2.kdbx', bytes);

        expect((await Svc.absorbConflictCopy(db, '/copies/vault 2.kdbx', sha256(bytes))).outcome).toBe('locked');
        expect(allTitles(db)).toEqual(['Kept']);
    });

    it('a file that is not a kdbx at all fails', async () => {
        await writeVault();
        const db = await openVault();
        const bytes = Buffer.from('not a database');
        copies.set('/copies/vault 2.kdbx', bytes);

        expect((await Svc.absorbConflictCopy(db, '/copies/vault 2.kdbx', sha256(bytes))).outcome).toBe('failed');
    });

    it('a copy that cannot be read fails', async () => {
        await writeVault();
        const db = await openVault();
        expect((await Svc.absorbConflictCopy(db, '/copies/gone 2.kdbx', 'unknown')).outcome).toBe('failed');
    });
});

describe('timing', () => {
    it('waits for a save in flight before merging', async () => {
        await writeVault();
        const db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');

        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const realSave = electron().saveToFile;
        let saveDone = false;
        electron().saveToFile = async (...args: unknown[]) => {
            await held;
            const result = await realSave(...args);
            saveDone = true;
            return result;
        };
        try {
            const model = Svc.convertKdbxToDatabase(db);
            const [edited] = Svc.saveEntry(model, { ...model.root.entries[0], notes: 'local' }, model.root, false);
            const save = Svc.saveDatabase(edited, db);
            await tick();
            let mergedAfterSave: boolean | null = null;
            const absorb = Svc.absorbConflictCopy(db, copy.path, copy.hash).then(result => {
                mergedAfterSave = saveDone;
                return result;
            });
            await tick();
            expect(mergedAfterSave).toBeNull();
            release();
            await save;
            expect((await absorb).outcome).toBe('merged');
            expect(mergedAfterSave).toBe(true);
        } finally {
            electron().saveToFile = realSave;
        }
    });

    it('a lock during the read discards the copy', async () => {
        await writeVault();
        const db = await openVault();
        const copy = await conflictCopy('vault 2.kdbx', 'FromPhone');

        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const readFile = electron().readFile;
        electron().readFile = async (path: string) => {
            await held;
            return readFile(path);
        };
        try {
            const absorb = Svc.absorbConflictCopy(db, copy.path, copy.hash);
            await tick();
            Svc.setPath(undefined);
            release();
            expect((await absorb).outcome).toBe('seen');
            expect(allTitles(db)).toEqual(['Kept']);
        } finally {
            electron().readFile = readFile;
        }
    });
});

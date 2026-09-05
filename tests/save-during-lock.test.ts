import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv, wireConflictResolver } from './helpers';

// A save outlives its vault easily: the KDF and the write run for seconds,
// and an auto-lock, a suspend or the extension's lock-database closes the
// vault meanwhile; the next vault can be open before the save finishes.
// The save still lands, in the file it was started for, and touches nothing
// that belongs to whatever vault is open by then.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
wireConflictResolver(Svc, env);

const electron = () => (globalThis as any).window.electron;

const writes: string[] = [];
let dialogs = 0;
// The next write waits at the gate until openGate() is called
let gate: Promise<void> | null = null;
let openGate: (() => void) | undefined;
const holdNextWrite = () => { gate = new Promise<void>(resolve => { openGate = resolve; }); };

const originalSaveToFile = electron().saveToFile;
electron().saveToFile = async (path: string, data: Uint8Array, backup?: unknown) => {
    writes.push(path);
    if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
    }
    return originalSaveToFile(path, data, backup);
};
const originalSaveFile = electron().saveFile;
electron().saveFile = async (data: Uint8Array) => {
    dialogs++;
    return originalSaveFile(data);
};

async function makeVault(title: string): Promise<Buffer> {
    const db0 = kdbxweb.Kdbx.create(cred(), title);
    db0.setVersion(3);
    const e = db0.createEntry(db0.getDefaultGroup());
    e.fields.set('Title', title);
    return Buffer.from(await db0.save());
}

beforeEach(() => {
    writes.length = 0;
    dialogs = 0;
    gate = null;
    openGate = undefined;
    env.toasts.length = 0;
});

describe('a save still running when the vault is locked', () => {
    it('writes to the path it started with and never opens a save dialog', async () => {
        env.disk.bytes = await makeVault('A');
        env.disk.mtime = 100;
        const kdbxDb = await loadSaved(env);
        Svc.setPath('/a.kdbx');
        await tick();

        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const [updated] = Svc.saveEntry(database, { ...database.root.entries[0], notes: 'edited' }, database.root, false);

        holdNextWrite();
        const save = Svc.saveDatabase(updated, kdbxDb);
        // Reach the write, then lock underneath it
        while (writes.length === 0) await tick();
        Svc.setPath(undefined);
        openGate!();
        await save;

        expect(writes).toEqual(['/a.kdbx']);
        expect(dialogs).toBe(0);
        expect(env.toasts).toContain('Database saved');
        const onDisk = await loadSaved(env);
        expect(onDisk.getDefaultGroup().entries[0].fields.get('Notes')).toBe('edited');
    });

    it('does not write over the vault opened next, nor move its baseline', async () => {
        env.disk.bytes = await makeVault('A');
        env.disk.mtime = 100;
        const vaultA = await loadSaved(env);
        Svc.setPath('/a.kdbx');
        await tick();

        const database = Svc.convertKdbxToDatabase(vaultA);
        const [updated] = Svc.saveEntry(database, { ...database.root.entries[0], notes: 'from A' }, database.root, false);

        holdNextWrite();
        const save = Svc.saveDatabase(updated, vaultA);
        while (writes.length === 0) await tick();

        // Lock A, open B: the disk now stands in for B's file
        Svc.setPath(undefined);
        const bytesB = await makeVault('B');
        env.disk.bytes = bytesB;
        env.disk.mtime = 500;
        const vaultB = await loadSaved(env);
        Svc.setPath('/b.kdbx', new Uint8Array(bytesB));
        await tick();

        openGate!();
        await save;
        expect(writes).toEqual(['/a.kdbx']);

        // B's baseline is what B was opened from. Had A's save refreshed it
        // to A's bytes, this save would read B's own file back as an
        // external change and merge it
        env.toasts.length = 0;
        const dbB = Svc.convertKdbxToDatabase(vaultB);
        const [updatedB] = Svc.saveEntry(dbB, { ...dbB.root.entries[0], notes: 'from B' }, dbB.root, false);
        await Svc.saveDatabase(updatedB, vaultB);
        expect(env.toasts.some(t => /merged/i.test(t))).toBe(false);
        expect(writes).toEqual(['/a.kdbx', '/b.kdbx']);
        expect(allTitles(await loadSaved(env))).toEqual(['B']);
    });

    it('a save queued behind it still targets the vault it was requested for', async () => {
        env.disk.bytes = await makeVault('A');
        env.disk.mtime = 100;
        const kdbxDb = await loadSaved(env);
        Svc.setPath('/a.kdbx');
        await tick();

        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const [first] = Svc.saveEntry(database, { ...database.root.entries[0], notes: 'first' }, database.root, false);
        const [second] = Svc.saveEntry(database, { ...database.root.entries[0], notes: 'second' }, database.root, false);

        holdNextWrite();
        const save1 = Svc.saveDatabase(first, kdbxDb);
        while (writes.length === 0) await tick();
        const save2 = Svc.saveDatabase(second, kdbxDb);
        Svc.setPath(undefined);
        openGate!();
        await Promise.all([save1, save2]);

        expect(writes).toEqual(['/a.kdbx', '/a.kdbx']);
        expect(dialogs).toBe(0);
        const onDisk = await loadSaved(env);
        expect(onDisk.getDefaultGroup().entries[0].fields.get('Notes')).toBe('second');
    });

    it('a database that never had a path fails instead of asking where to save a closed vault', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'New');
        db0.setVersion(3);
        (db0.header as any).keyEncryptionRounds = 1000;
        db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'New');
        Svc.setPath(undefined);

        const database = Svc.convertKdbxToDatabase(db0);
        const [updated] = Svc.saveEntry(database, { ...database.root.entries[0], notes: 'n' }, database.root, false);
        const save = Svc.saveDatabase(updated, db0);
        // Closed before the first save could ask for a path
        Svc.setPath(undefined);
        await expect(save).rejects.toThrow(/closed before/);
        expect(dialogs).toBe(0);
    });
});

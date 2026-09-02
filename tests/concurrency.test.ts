import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

describe('concurrent-change protection', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const entry = db0.createEntry(db0.getDefaultGroup());
        entry.fields.set('Title', 'Shared');
        entry.fields.set('UserName', 'base-user');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
        env.disk.bytes = Buffer.from(await db0.save());
        env.disk.mtime = 100;

        kdbxDb = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick(); // let the async mtime baseline land
    });

    it('saves without merging when the file is unchanged', async () => {
        env.toasts.length = 0;
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const [updated] = Svc.saveEntry(database, { ...database.root.entries[0], notes: 'local note' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);
        expect(env.toasts).toContain('Database saved successfully');
        expect(env.toasts.some(t => /merged/i.test(t))).toBe(false);
        expect(env.confirm.calls).toBe(0);
    });

    it('merges an external addition instead of clobbering it', async () => {
        // another client adds an entry and writes the file
        const remote = await loadSaved(env);
        const added = remote.createEntry(remote.getDefaultGroup());
        added.fields.set('Title', 'RemoteEntry');
        added.fields.set('Password', kdbxweb.ProtectedValue.fromString('remote-pw'));
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime += 50;

        env.toasts.length = 0;
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const [updated] = Svc.saveEntry(database, { ...database.root.entries[0], username: 'local-edit' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        expect(env.toasts.some(t => /merged/i.test(t))).toBe(true);
        // The version that was on disk is about to be gone, so the copy taken
        // before the write must not be skipped for being too recent
        expect(env.lastBackup?.replacingExternalChanges).toBe(true);
        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).toContain('RemoteEntry');
        const shared = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Shared')!;
        expect(shared.fields.get('UserName')).toBe('local-edit');
    });

    it('refreshes the baseline so the next save does not re-merge', async () => {
        kdbxDb = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();
        env.toasts.length = 0;
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const shared = database.root.entries.find(e => e.title === 'Shared')!;
        const [updated] = Svc.saveEntry(database, { ...shared, notes: 'note 2' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);
        expect(env.toasts.some(t => /merged/i.test(t))).toBe(false);
    });

    it('ignores a new timestamp when the bytes are unchanged', async () => {
        kdbxDb = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();

        // What a sync mount does: the file is uploaded and its timestamp comes
        // back changed, or is reported at a different precision, while the
        // contents are exactly what we wrote. Merging on that alone means
        // merging the file with itself and telling the user it changed
        env.disk.mtime += 50;

        env.toasts.length = 0;
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const shared = database.root.entries.find(e => e.title === 'Shared')!;
        const [updated] = Svc.saveEntry(database, { ...shared, notes: 'local only' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        expect(env.toasts.some(t => /merged/i.test(t))).toBe(false);
        expect(env.toasts).toContain('Database saved successfully');
        expect(env.confirm.calls).toBe(0);
        // Nothing was replaced, so the ordinary spacing applies
        expect(env.lastBackup?.replacingExternalChanges).toBe(false);
    });

    it('keeps ignoring it save after save', async () => {
        // The touched timestamp is adopted as the new baseline, so a mount
        // that does this on every save does not cost a re-read every time
        for (let i = 0; i < 3; i++) {
            env.disk.mtime += 50;
            env.toasts.length = 0;
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            const shared = database.root.entries.find(e => e.title === 'Shared')!;
            const [updated] = Svc.saveEntry(database, { ...shared, notes: `pass ${i}` }, database.root, false);
            await Svc.saveDatabase(updated, kdbxDb);
            expect(env.toasts.some(t => /merged/i.test(t))).toBe(false);
        }
    });

    it('resolves a same-entry conflict to the newer edit', async () => {
        const remote = await loadSaved(env);
        const rShared = remote.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Shared')!;
        rShared.pushHistory();
        rShared.fields.set('UserName', 'remote-user');
        rShared.times.lastModTime = new Date(Date.now() - 60000);
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime += 50;

        env.toasts.length = 0;
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const shared = database.root.entries.find(e => e.title === 'Shared')!;
        const [updated] = Svc.saveEntry(database, { ...shared, username: 'newer-local-user' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        expect(env.toasts.some(t => /merged/i.test(t))).toBe(true);
        const onDisk = await loadSaved(env);
        expect(onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Shared')!.fields.get('UserName')).toBe('newer-local-user');
    });

    it('aborts the save when merge fails and the user declines to overwrite', async () => {
        kdbxDb = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();
        env.disk.bytes = Buffer.from('garbage that is not a kdbx file at all');
        env.disk.mtime += 50;
        env.confirm.answer = false;
        env.confirm.calls = 0;

        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const shared = database.root.entries.find(e => e.title === 'Shared')!;
        const [updated] = Svc.saveEntry(database, { ...shared, notes: 'should not land' }, database.root, false);
        await expect(Svc.saveDatabase(updated, kdbxDb)).rejects.toThrow('SAVE_CANCELLED_CONFLICT');
        expect(env.confirm.calls).toBe(1);
        expect(env.disk.bytes!.toString()).toBe('garbage that is not a kdbx file at all');
    });

    it('overwrites when merge fails and the user accepts', async () => {
        env.confirm.answer = true;
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const shared = database.root.entries.find(e => e.title === 'Shared')!;
        const [updated] = Svc.saveEntry(database, { ...shared, notes: 'overwrite ok' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);
        // Discarding an unmergeable version outright is the most destructive
        // save there is; it has to be preceded by a copy
        expect(env.lastBackup?.replacingExternalChanges).toBe(true);
        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).toContain('Shared');
    });
});

describe('overlapping saves', () => {
    it('serializes them instead of interleaving their mutations', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const first = db0.createEntry(db0.getDefaultGroup());
        first.fields.set('Title', 'One');
        env.disk.bytes = Buffer.from(await db0.save());
        env.disk.mtime = 500;

        const db = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();

        // Two edits fired without awaiting the first save, the way a quick
        // second edit or a browser-integration write arriving mid-save does
        const base = Svc.convertKdbxToDatabase(db);
        const [withTwo] = Svc.saveEntry(base, { ...Svc.createNewEntry(), title: 'Two' }, base.root, true);
        const [withThree] = Svc.saveEntry(withTwo, { ...Svc.createNewEntry(), title: 'Three' }, withTwo.root, true);

        await Promise.all([Svc.saveDatabase(withTwo, db), Svc.saveDatabase(withThree, db)]);

        // Two overlapping kdbxDb.save() calls regenerate the shared header
        // salts under each other, so the file lands with a header from one
        // save and a body encrypted under the other's key: loading it at all
        // is the assertion that matters here
        const saved = await loadSaved(env);
        expect(allTitles(saved).sort()).toEqual(['One', 'Three', 'Two']);
    });

    it('collapses a burst of overlapping saves into at most two writes', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'One');
        env.disk.bytes = Buffer.from(await db0.save());
        env.disk.mtime = 900;
        const db = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();

        const electron = (globalThis as any).window.electron;
        const original = electron.saveToFile;
        let writes = 0;
        electron.saveToFile = async (...args: unknown[]) => { writes++; return original(...args); };

        // Four edits fired back to back without awaiting, like a multi-entry
        // drag: one save runs, the other three collapse into one follow-up
        let base = Svc.convertKdbxToDatabase(db);
        const saves: Promise<void>[] = [];
        for (const title of ['Two', 'Three', 'Four', 'Five']) {
            const [next] = Svc.saveEntry(base, { ...Svc.createNewEntry(), title }, base.root, true);
            base = next;
            saves.push(Svc.saveDatabase(next, db));
        }
        await Promise.all(saves);
        electron.saveToFile = original;

        expect(writes).toBe(2);
        // Collapsing must not drop any of the edits it collapsed
        expect(allTitles(await loadSaved(env)).sort()).toEqual(['Five', 'Four', 'One', 'Three', 'Two']);
    });

    it('keeps running after a save fails', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
        env.disk.bytes = Buffer.from(await db0.save());
        const db = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();

        const electron = (globalThis as any).window.electron;
        const saveToFile = electron.saveToFile;
        const saveFile = electron.saveFile;
        electron.saveToFile = async () => ({ success: false, error: 'disk full' });
        electron.saveFile = async () => ({ success: false, error: 'disk full' });
        await expect(Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db)).rejects.toThrow();
        electron.saveToFile = saveToFile;
        electron.saveFile = saveFile;

        // A rejection must not leave the chain permanently broken
        const database = Svc.convertKdbxToDatabase(db);
        const [updated] = Svc.saveEntry(database, { ...Svc.createNewEntry(), title: 'After' }, database.root, true);
        await Svc.saveDatabase(updated, db);
        expect(allTitles(await loadSaved(env))).toContain('After');
    });
});

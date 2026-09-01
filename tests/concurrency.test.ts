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
        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).toContain('Shared');
    });
});

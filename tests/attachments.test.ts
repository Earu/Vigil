import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, ab, attachmentBytes, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

describe('entry attachments', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Test');
        db0.setVersion(3);
        const entry = db0.createEntry(db0.getDefaultGroup());
        entry.fields.set('Title', 'EntryA');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pwA'));
        entry.binaries.set('existing.txt', await db0.createBinary(ab('pre-existing file')));
        kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
    });

    it('exposes existing attachments on convert', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        expect(entry.attachments).toHaveLength(1);
        expect(entry.attachments[0].name).toBe('existing.txt');
        expect(Buffer.from(Svc.getAttachmentBytes(entry.attachments[0])).toString()).toBe('pre-existing file');
        expect(Svc.getAttachmentSize(entry.attachments[0])).toBe('pre-existing file'.length);
    });

    it('preserves attachment data through deepCopy', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const copied = Svc.deepCopyWithDates(database.root.entries[0]);
        expect(Buffer.from(Svc.getAttachmentBytes(copied.attachments[0])).toString()).toBe('pre-existing file');
    });

    it('adds an attachment and round-trips it through save/load', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        const edited = { ...entry, attachments: [...entry.attachments, { name: 'id_rsa', data: ab('SECRET-KEY-DATA') }] };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.binaries.size).toBe(2);
        expect(attachmentBytes(reEntry, 'existing.txt')?.toString()).toBe('pre-existing file');
        expect(attachmentBytes(reEntry, 'id_rsa')?.toString()).toBe('SECRET-KEY-DATA');
        expect((reEntry.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('pwA');
        kdbxDb = reloaded;
    });

    it('keeps attachments through an unrelated edit', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const [updated] = Svc.saveEntry(database, { ...database.root.entries[0], username: 'newuser' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.binaries.size).toBe(2);
        expect(attachmentBytes(reEntry, 'id_rsa')?.toString()).toBe('SECRET-KEY-DATA');
        expect(reEntry.fields.get('UserName')).toBe('newuser');
        kdbxDb = reloaded;
    });

    it('creates a new entry with an attachment', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const fresh = Svc.createNewEntry();
        fresh.title = 'EntryB';
        fresh.password = 'pwB';
        fresh.attachments.push({ name: 'note.md', data: ab('# hello') });
        const [updated] = Svc.saveEntry(database, Svc.prepareEntryForSave(fresh), database.root, true);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const entryB = reloaded.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'EntryB');
        expect(entryB).toBeDefined();
        expect(attachmentBytes(entryB!, 'note.md')?.toString()).toBe('# hello');
        kdbxDb = reloaded;
    });

    it('removes an attachment, keeps it recoverable via history, then drops it once unreferenced', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entryA = database.root.entries.find(e => e.title === 'EntryA')!;
        const edited = { ...entryA, attachments: entryA.attachments.filter(a => a.name !== 'id_rsa') };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        let reloaded = await loadSaved(env);
        let reEntry = reloaded.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'EntryA')!;
        expect(reEntry.binaries.has('id_rsa')).toBe(false);
        expect(attachmentBytes(reEntry, 'existing.txt')?.toString()).toBe('pre-existing file');
        // the pre-removal history revision still references the file
        expect(reEntry.history.some(h => h.binaries.has('id_rsa'))).toBe(true);

        // once no history references it, the binary leaves the file entirely
        reEntry.history = [];
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(reloaded), reloaded);
        expect(env.disk.bytes!.toString('latin1')).not.toContain('SECRET-KEY-DATA');
    });

    it('round-trips attachments in kdbx4 across two save cycles', async () => {
        const db4 = kdbxweb.Kdbx.create(cred(), 'V4');
        db4.header.setKdf(kdbxweb.Consts.KdfId.Aes);
        const entry = db4.createEntry(db4.getDefaultGroup());
        entry.fields.set('Title', 'V4Entry');

        const converted = Svc.convertKdbxToDatabase(db4);
        converted.root.entries[0].attachments = [{ name: 'blob.bin', data: Uint8Array.from([9, 8, 7]).buffer }];
        await Svc.saveDatabase(converted, db4);

        const first = await loadSaved(env);
        expect(first.header.versionMajor).toBe(4);
        expect(attachmentBytes(first.getDefaultGroup().entries[0], 'blob.bin')).toEqual(Buffer.from([9, 8, 7]));

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(first), first);
        const second = await loadSaved(env);
        expect(attachmentBytes(second.getDefaultGroup().entries[0], 'blob.bin')).toEqual(Buffer.from([9, 8, 7]));
    });
});

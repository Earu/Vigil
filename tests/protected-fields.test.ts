import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, tick, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

// KeePass has a database-wide memory-protection setting for each standard
// field, so UserName, URL and Notes can arrive as ProtectedValue. Reading one
// with toString() yields base64 of the obfuscated bytes, not the text, so
// getting this wrong shows ciphertext in the UI and writes it back as the
// value on the next save.
async function vaultWithProtectedFields(): Promise<kdbxweb.Kdbx> {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', 'Bank');
    entry.fields.set('UserName', kdbxweb.ProtectedValue.fromString('secret-user'));
    entry.fields.set('URL', kdbxweb.ProtectedValue.fromString('https://bank.example'));
    entry.fields.set('Notes', kdbxweb.ProtectedValue.fromString('recovery codes'));
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
    env.disk.bytes = Buffer.from(await db.save());
    env.disk.mtime = 100;
    return db;
}

describe('protected standard fields', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeEach(async () => {
        await vaultWithProtectedFields();
        kdbxDb = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();
        env.toasts.length = 0;
    });

    it('reads them as text rather than as obfuscated bytes', () => {
        const entry = Svc.convertKdbxToDatabase(kdbxDb).root.entries[0];
        expect(entry.username).toBe('secret-user');
        expect(entry.url).toBe('https://bank.example');
        expect(entry.notes).toBe('recovery codes');
        expect(entry.protectedFields).toEqual(['UserName', 'URL', 'Notes']);
    });

    it('keeps both the value and the protection through an unrelated edit', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const [updated] = Svc.saveEntry(
            database, { ...database.root.entries[0], title: 'Bank (renamed)' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const saved = (await loadSaved(env)).getDefaultGroup().entries[0];
        for (const name of ['UserName', 'URL', 'Notes']) {
            expect(saved.fields.get(name)).toBeInstanceOf(kdbxweb.ProtectedValue);
        }
        expect((saved.fields.get('UserName') as kdbxweb.ProtectedValue).getText()).toBe('secret-user');
        expect((saved.fields.get('Notes') as kdbxweb.ProtectedValue).getText()).toBe('recovery codes');
        expect(saved.fields.get('Title')).toBe('Bank (renamed)');
        // Title was not protected in the file and must not become so
        expect(saved.fields.get('Title')).not.toBeInstanceOf(kdbxweb.ProtectedValue);
    });

    it('records no history revision when nothing changed', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        await Svc.saveDatabase(database, kdbxDb);
        expect(kdbxDb.getDefaultGroup().entries[0].history).toHaveLength(0);
    });

    it('leaves an unprotected vault unprotected', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Plain');
        db.setVersion(3);
        const e = db.createEntry(db.getDefaultGroup());
        e.fields.set('Title', 'Site');
        e.fields.set('UserName', 'plain-user');
        e.fields.set('Notes', 'plain notes');
        env.disk.bytes = Buffer.from(await db.save());
        const plain = await loadSaved(env);
        await tick();

        const database = Svc.convertKdbxToDatabase(plain);
        expect(database.root.entries[0].protectedFields).toEqual([]);
        const [updated] = Svc.saveEntry(
            database, { ...database.root.entries[0], title: 'Site 2' }, database.root, false);
        await Svc.saveDatabase(updated, plain);

        const saved = (await loadSaved(env)).getDefaultGroup().entries[0];
        expect(saved.fields.get('UserName')).toBe('plain-user');
        expect(saved.fields.get('Notes')).toBe('plain notes');
    });

    it('applies the database memory-protection settings to a new entry', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Protected');
        db.setVersion(3);
        db.meta.memoryProtection = { title: false, userName: true, password: true, url: false, notes: true };
        env.disk.bytes = Buffer.from(await db.save());
        const opened = await loadSaved(env);
        await tick();

        const database = Svc.convertKdbxToDatabase(opened);
        const fresh = { ...Svc.createNewEntry(), title: 'New', username: 'someone', notes: 'private' };
        const [updated] = Svc.saveEntry(database, fresh, database.root, true);
        await Svc.saveDatabase(updated, opened);

        const saved = (await loadSaved(env)).getDefaultGroup().entries[0];
        expect(saved.fields.get('UserName')).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect(saved.fields.get('Notes')).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect(saved.fields.get('Title')).toBe('New');
        expect((saved.fields.get('UserName') as kdbxweb.ProtectedValue).getText()).toBe('someone');
    });
});

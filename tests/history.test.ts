import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, ab, attachmentBytes, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const findSite = (db: kdbxweb.Kdbx) =>
    db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Site')!;

describe('entry history', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const site = db0.createEntry(db0.getDefaultGroup());
        site.fields.set('Title', 'Site');
        site.fields.set('UserName', 'user-v1');
        site.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw-v1'));
        const other = db0.createEntry(db0.getDefaultGroup());
        other.fields.set('Title', 'Other');
        other.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw-other'));
        kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
    });

    it('pushes exactly one revision holding the old values on edit', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const site = database.root.entries.find(e => e.title === 'Site')!;
        const [updated] = Svc.saveEntry(database, { ...site, username: 'user-v2', password: 'pw-v2' }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reSite = findSite(reloaded);
        expect(reSite.history).toHaveLength(1);
        expect(reSite.history[0].fields.get('UserName')).toBe('user-v1');
        expect((reSite.history[0].fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('pw-v1');
        expect(reSite.fields.get('UserName')).toBe('user-v2');
        const reOther = reloaded.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Other')!;
        expect(reOther.history).toHaveLength(0);
        kdbxDb = reloaded;
    });

    it('adds no revisions when saving without changes', async () => {
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(kdbxDb), kdbxDb);
        const reloaded = await loadSaved(env);
        expect(findSite(reloaded).history).toHaveLength(1);
        expect(reloaded.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Other')!.history).toHaveLength(0);
        kdbxDb = reloaded;
    });

    it('treats attachment changes as changes and keeps removed files recoverable', async () => {
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        let site = database.root.entries.find(e => e.title === 'Site')!;
        let [updated] = Svc.saveEntry(database, { ...site, attachments: [{ name: 'key.pem', data: ab('PRIVATE-KEY') }] }, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);
        let reloaded = await loadSaved(env);
        expect(findSite(reloaded).history).toHaveLength(2);

        database = Svc.convertKdbxToDatabase(reloaded);
        site = database.root.entries.find(e => e.title === 'Site')!;
        [updated] = Svc.saveEntry(database, { ...site, attachments: [] }, database.root, false);
        await Svc.saveDatabase(updated, reloaded);
        reloaded = await loadSaved(env);
        const reSite = findSite(reloaded);
        expect(reSite.history).toHaveLength(3);
        expect(reSite.binaries.size).toBe(0);
        const lastRevision = reSite.history[reSite.history.length - 1];
        expect(attachmentBytes(lastRevision as unknown as kdbxweb.KdbxEntry, 'key.pem')?.toString()).toBe('PRIVATE-KEY');
        kdbxDb = reloaded;
    });

    it('exposes history in the model and round-trips a restore', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const site = database.root.entries.find(e => e.title === 'Site')!;
        expect(site.history).toHaveLength(3);
        expect(site.history[0].username).toBe('user-v1');

        const restoreFrom = site.history[0];
        const restored = Svc.prepareEntryForSave({
            ...site,
            title: restoreFrom.title,
            username: restoreFrom.username,
            password: restoreFrom.password,
            url: restoreFrom.url,
            notes: restoreFrom.notes,
            attachments: restoreFrom.attachments,
        });
        const [updated] = Svc.saveEntry(database, restored, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reSite = findSite(reloaded);
        expect(reSite.fields.get('UserName')).toBe('user-v1');
        expect((reSite.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('pw-v1');
        expect(reSite.history).toHaveLength(4);
        expect(reSite.history[3].fields.get('UserName')).toBe('user-v2');
        kdbxDb = reloaded;
    });

    it('enforces history retention rules on save', async () => {
        kdbxDb.meta.historyMaxItems = 5;
        for (let i = 0; i < 8; i++) {
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            const site = database.root.entries.find(e => e.title === 'Site')!;
            const [updated] = Svc.saveEntry(database, { ...site, notes: `edit ${i}` }, database.root, false);
            await Svc.saveDatabase(updated, kdbxDb);
            kdbxDb = await loadSaved(env);
        }
        const reSite = findSite(kdbxDb);
        expect(reSite.history.length).toBeLessThanOrEqual(5);
        expect(reSite.history[reSite.history.length - 1].fields.get('Notes')?.toString()).toBe('edit 6');
    });
});

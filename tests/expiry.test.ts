import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

describe('entry expiry', () => {
    let kdbxDb: kdbxweb.Kdbx;
    const expiry = new Date('2030-06-15T12:00:00Z');

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const entry = db0.createEntry(db0.getDefaultGroup());
        entry.fields.set('Title', 'Site');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
        kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
    });

    it('converts entries without expiry as not expiring', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        expect(database.root.entries[0].expires).toBe(false);
    });

    it('sets an expiry date and round-trips it', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const edited = { ...database.root.entries[0], expires: true, expiryTime: expiry };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.times.expires).toBe(true);
        expect(reEntry.times.expiryTime?.getTime()).toBe(expiry.getTime());
        // setting the expiry counted as a change, so one history revision
        expect(reEntry.history).toHaveLength(1);
        kdbxDb = reloaded;
    });

    it('adds no history revision when expiry is unchanged', async () => {
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(kdbxDb), kdbxDb);
        const reloaded = await loadSaved(env);
        expect(reloaded.getDefaultGroup().entries[0].history).toHaveLength(1);
        kdbxDb = reloaded;
    });

    it('clears the expiry flag while keeping the date', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const edited = { ...database.root.entries[0], expires: false };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.times.expires).toBe(false);
        expect(reEntry.times.expiryTime?.getTime()).toBe(expiry.getTime());
        expect(reEntry.history).toHaveLength(2);
    });

    it('detects expired entries', () => {
        const past = new Date(Date.now() - 1000);
        const future = new Date(Date.now() + 1000 * 60);
        expect(Svc.isEntryExpired({ expires: true, expiryTime: past })).toBe(true);
        expect(Svc.isEntryExpired({ expires: true, expiryTime: future })).toBe(false);
        expect(Svc.isEntryExpired({ expires: false, expiryTime: past })).toBe(false);
        expect(Svc.isEntryExpired({ expires: true })).toBe(false);
    });

    it('exposes expiry in history versions', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        // the middle revision had expiry enabled
        expect(entry.history.some(v => v.expires && v.expiryTime?.getTime() === expiry.getTime())).toBe(true);
    });
});

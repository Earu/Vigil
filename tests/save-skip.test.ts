import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    for (let i = 0; i < 3; i++) {
        const entry = db0.createEntry(db0.getDefaultGroup());
        entry.fields.set('Title', `Entry ${i}`);
        entry.fields.set('UserName', `user${i}`);
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(`pw${i}`));
    }
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

describe('save path skips unchanged entries', () => {
    it('a no-change save pushes no history and keeps timestamps', async () => {
        const db = await makeDb();
        const modTimesBefore = db.getDefaultGroup().entries.map(e => e.times.lastModTime?.getTime());

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        const reloaded = await loadSaved(env);
        for (const [i, entry] of reloaded.getDefaultGroup().entries.entries()) {
            expect(entry.history.length).toBe(0);
            expect(entry.times.lastModTime?.getTime()).toBe(modTimesBefore[i]);
            expect(entry.fields.get('Title')).toBe(`Entry ${i}`);
        }
    });

    it('editing one entry snapshots only that entry', async () => {
        const db = await makeDb();
        const database = Svc.convertKdbxToDatabase(db);
        const edited = { ...database.root.entries[1], title: 'Entry 1 renamed', modified: new Date() };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, db);

        const reloaded = await loadSaved(env);
        const entries = reloaded.getDefaultGroup().entries;
        const renamed = entries.find(e => e.fields.get('Title') === 'Entry 1 renamed')!;
        expect(renamed).toBeDefined();
        expect(renamed.history.length).toBe(1);
        expect(renamed.history[0].fields.get('Title')).toBe('Entry 1');
        for (const entry of entries) {
            if (entry !== renamed) expect(entry.history.length).toBe(0);
        }
        // untouched entries still read back correctly
        const other = entries.find(e => e.fields.get('Title') === 'Entry 0')!;
        expect((other.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('pw0');
    });
});

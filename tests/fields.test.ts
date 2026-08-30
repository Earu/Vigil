import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

describe('field clearing and root group name', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        db0.getDefaultGroup().name = 'MySecrets';
        const entry = db0.createEntry(db0.getDefaultGroup());
        entry.fields.set('Title', 'Site');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
        entry.fields.set('URL', 'https://old.example.com');
        entry.fields.set('Notes', 'old notes');
        kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
    });

    it('clears URL and Notes in the file when emptied', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        expect(database.root.entries[0].url).toBe('https://old.example.com');
        const cleared = { ...database.root.entries[0], url: '', notes: '' };
        const [updated] = Svc.saveEntry(database, cleared, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.fields.get('URL')).toBeUndefined();
        expect(reEntry.fields.get('Notes')).toBeUndefined();
        expect(reEntry.fields.get('Title')).toBe('Site');
        kdbxDb = reloaded;
    });

    it('re-sets a cleared field', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const restored = { ...database.root.entries[0], url: 'https://new.example.com' };
        const [updated] = Svc.saveEntry(database, restored, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        expect(reloaded.getDefaultGroup().entries[0].fields.get('URL')).toBe('https://new.example.com');
        kdbxDb = reloaded;
    });

    it('labels the root "All Entries" in the UI but preserves the real name on disk', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        expect(database.root.name).toBe('All Entries');
        expect(kdbxDb.getDefaultGroup().name).toBe('MySecrets');
    });

    it('keeps subgroup renames working while the root name stays intact', async () => {
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        await Svc.saveDatabase(Svc.addNewGroup(database, database.root), kdbxDb);
        let reloaded = await loadSaved(env);
        expect(reloaded.getDefaultGroup().groups.some(g => g.name === 'New Group')).toBe(true);

        database = Svc.convertKdbxToDatabase(reloaded);
        const sub = database.root.groups.find(g => g.name === 'New Group')!;
        await Svc.saveDatabase(Svc.updateGroupName(database, sub, 'Work'), reloaded);
        reloaded = await loadSaved(env);
        expect(reloaded.getDefaultGroup().groups.some(g => g.name === 'Work')).toBe(true);
        expect(reloaded.getDefaultGroup().name).toBe('MySecrets');
    });
});

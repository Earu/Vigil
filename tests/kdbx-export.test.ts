import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

// "Save encrypted copy": the vault serialized as it stands, decryptable with
// the same credentials. kdbx.save() regenerates header salts as it runs, so
// the copy takes the same lock the saves use rather than serializing beside
// one.

installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

async function vault() {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const root = db.getDefaultGroup();
    const entry = db.createEntry(root);
    entry.fields.set('Title', 'Mail');
    entry.fields.set('UserName', 'alice');
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('hunter2'));
    return db;
}

describe('exportDatabaseCopy', () => {
    it('produces a copy that opens with the same credentials and holds the entries', async () => {
        const db = await vault();
        const bytes = await Svc.exportDatabaseCopy(db);

        const copy = await kdbxweb.Kdbx.load(bytes, cred());
        const entries = copy.getDefaultGroup().entries;
        expect(entries).toHaveLength(1);
        expect(entries[0].fields.get('Title')).toBe('Mail');
        expect((entries[0].fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('hunter2');
    });

    it('is a copy, so the live database keeps its own identity', async () => {
        const db = await vault();
        const bytes = await Svc.exportDatabaseCopy(db);
        const copy = await kdbxweb.Kdbx.load(bytes, cred());

        // Same content, same uuids: an entry edited in the copy would merge
        // back as the same object, exactly what a backup restore needs
        expect(copy.getDefaultGroup().entries[0].uuid.id).toBe(db.getDefaultGroup().entries[0].uuid.id);
    });

    it('waits out an in-flight save instead of serializing beside it', async () => {
        const db = await vault();

        let releaseSave!: () => void;
        const saving = new Promise<void>(resolve => { releaseSave = resolve; });
        (Svc as any).saveInFlight = true;
        (Svc as any).currentSave = saving;

        let done = false;
        const exported = Svc.exportDatabaseCopy(db).then(bytes => { done = true; return bytes; });

        await new Promise(resolve => setTimeout(resolve, 20));
        expect(done).toBe(false);

        (Svc as any).saveInFlight = false;
        releaseSave();
        const bytes = await exported;
        expect(done).toBe(true);
        expect((await kdbxweb.Kdbx.load(bytes, cred())).getDefaultGroup().entries).toHaveLength(1);
    });

    it('releases the save lock when it finishes', async () => {
        const db = await vault();
        await Svc.exportDatabaseCopy(db);
        expect((Svc as any).saveInFlight).toBe(false);
    });
});

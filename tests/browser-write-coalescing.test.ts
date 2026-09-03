import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv } from './helpers';

// While a save is in flight, saveDatabase collapses queued requests by
// replacing the queued model with the newest one. That assumes models are
// cumulative. The browser integration breaks the assumption: it writes onto
// kdbxDb directly and queues a save with a model built at that moment, and a
// UI save queued right after still carries the model React held before the
// write. Replacing the queue with that older model drops the browser's entry
// and records a tombstone for it, which a later merge then propagates as a
// deletion to every replica.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Db } = await import('../src/services/KeepassDatabaseService');
const { BrowserIntegrationService: Browser } = await import('../src/services/BrowserIntegrationService');

const tombstones = (db: kdbxweb.Kdbx) => db.deletedObjects.map(d => d.uuid!.toString());

async function freshVault(): Promise<kdbxweb.Kdbx> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const kept = db0.createEntry(db0.getDefaultGroup());
    kept.fields.set('Title', 'Kept');
    kept.fields.set('URL', 'https://kept.example');
    kept.fields.set('Password', kdbxweb.ProtectedValue.fromString('old-pw'));
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Other');
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 500;
    const db = await loadSaved(env);
    Db.setPath('/fake.kdbx');
    await tick();
    return db;
}

// KeePassXC-Browser addresses entries by the hex spelling of their uuid
const uuidHexOf = (entry: kdbxweb.KdbxEntry): string =>
    [...kdbxweb.ByteUtils.base64ToBytes(entry.uuid.id)]
        .map(b => b.toString(16).padStart(2, '0')).join('');

// The ctx App.tsx builds for browser requests: saveDatabase converts a fresh
// model from kdbxDb at call time and hands it to the database service
const appCtx = (db: kdbxweb.Kdbx) => ({
    database: {} as any,
    kdbxDb: db,
    saveDatabase: async () => {
        await Db.saveDatabase(Db.convertKdbxToDatabase(db), db);
    },
    requestSetLoginConsent: async () => true,
});

describe('a browser write racing a UI save', () => {
    it('survives without a concurrent UI save', async () => {
        // Sanity for the harness: the same set-login with nothing else going
        // on persists the entry
        const db = await freshVault();
        const result = await Browser.handleRequest(
            'set-login',
            { url: 'https://site.example', login: 'user', password: 'pw' },
            appCtx(db)
        );
        expect(result.errorCode).toBeUndefined();
        expect(allTitles(await loadSaved(env))).toContain('site.example');
    });

    it('is not tombstoned by a stale UI model queued behind it', async () => {
        const db = await freshVault();
        const electron = (globalThis as any).window.electron;
        const saveToFile = electron.saveToFile;
        electron.saveToFile = async (...args: unknown[]) => { await tick(); return saveToFile(...args); };

        // The model React holds before any of this happens
        const stale = Db.convertKdbxToDatabase(db);

        // Save #1: a user edit, in flight for a while
        const [edited] = Db.saveEntry(stale, { ...stale.root.entries[0], notes: 'local edit' }, stale.root, false);
        const first = Db.saveDatabase(edited, db);

        // The extension saves a login while save #1 is writing; its save is
        // queued with a model that has the new entry
        const browserRequest = Browser.handleRequest(
            'set-login',
            { url: 'https://site.example', login: 'user', password: 'pw' },
            appCtx(db)
        );
        await new Promise(resolve => setTimeout(resolve, 0));

        // The UI queues another edit before React has shown it the browser's
        // entry; this model replaces the browser's in the queue
        const [editedAgain] = Db.saveEntry(edited, { ...edited.root.entries[0], notes: 'second edit' }, edited.root, false);
        const second = Db.saveDatabase(editedAgain, db);

        const [, browserResult] = await Promise.all([first, browserRequest, second]);
        electron.saveToFile = saveToFile;

        // The extension was told the write succeeded
        expect(browserResult.errorCode).toBeUndefined();

        // So the entry must be on disk, and must not be recorded as a
        // deletion the user chose
        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk)).toContain('site.example');
        expect(tombstones(onDisk)).toEqual([]);
        const kept = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Kept')!;
        expect(kept.fields.get('Notes')).toBe('second edit');
    });

    it('an update to an existing entry is not reverted by a stale UI model queued behind it', async () => {
        const db = await freshVault();
        const electron = (globalThis as any).window.electron;
        const saveToFile = electron.saveToFile;
        electron.saveToFile = async (...args: unknown[]) => { await tick(); return saveToFile(...args); };

        const stale = Db.convertKdbxToDatabase(db);
        const keptKdbx = db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Kept')!;
        const otherModel = stale.root.entries.find(e => e.title === 'Other')!;

        // Save #1: the user edits a different entry, in flight for a while
        const [edited] = Db.saveEntry(stale, { ...otherModel, notes: 'user edit' }, stale.root, false);
        const first = Db.saveDatabase(edited, db);

        // The extension updates Kept's password mid-save
        const browserRequest = Browser.handleRequest(
            'set-login',
            { uuid: uuidHexOf(keptKdbx), url: 'https://kept.example', login: 'kept-user', password: 'new-pw' },
            appCtx(db)
        );
        await new Promise(resolve => setTimeout(resolve, 0));

        // The UI queues another edit to the other entry from a model that
        // still carries Kept's old password
        const editedOther = edited.root.entries.find(e => e.title === 'Other')!;
        const [editedAgain] = Db.saveEntry(edited, { ...editedOther, notes: 'second user edit' }, edited.root, false);
        const second = Db.saveDatabase(editedAgain, db);

        const [, browserResult] = await Promise.all([first, browserRequest, second]);
        electron.saveToFile = saveToFile;
        expect(browserResult.errorCode).toBeUndefined();

        // The extension was told the update landed, so the file must hold the
        // new password; the user's own edit to the other entry lands too
        const onDisk = await loadSaved(env);
        const kept = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Kept')!;
        expect((kept.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('new-pw');
        const other = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Other')!;
        expect(other.fields.get('Notes')).toBe('second user edit');
    });
});

import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

// Tags are a 4.1 field, so anything checking they survive a save needs a 4.1
// file. AES rather than the Argon2 default only because the test environment
// has no argon2 binding
const vault = async () => {
    const db = kdbxweb.Kdbx.create(cred(), 'Tagged');
    db.setVersion(4);
    db.header.versionMinor = 1;
    db.header.setKdf(kdbxweb.Consts.KdfId.Aes);
    const e = db.createEntry(db.getDefaultGroup());
    e.fields.set('Title', 'Router');
    e.fields.set('UserName', 'admin');
    e.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
    return await kdbxweb.Kdbx.load(await db.save(), cred());
};

const theEntry = (db: kdbxweb.Kdbx) => [...db.getDefaultGroup().allEntries()][0];

describe('normalizeTags', () => {
    it('strips the delimiters kdbx would split a tag on', () => {
        // stored as one string split on /\s*[;,:]\s*/, so these cannot survive
        expect(Svc.normalizeTags(['home:lab', 'a,b', 'x;y'])).toEqual(['homelab', 'ab', 'xy']);
    });

    it('trims, drops blanks and de-duplicates case-insensitively', () => {
        expect(Svc.normalizeTags(['  Work ', 'work', '', '   ', 'VPN'])).toEqual(['Work', 'VPN']);
    });
});

describe('tags on an entry', () => {
    it('round-trips through a save', async () => {
        const kdbxDb = await vault();
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        expect(entry.tags).toEqual([]);

        entry.tags = ['Work', 'network'];
        await Svc.saveDatabase(Svc.saveEntry(database, Svc.prepareEntryForSave(entry), database.root, false)[0], kdbxDb);

        const reloaded = await loadSaved(env);
        expect(theEntry(reloaded).tags).toEqual(['Work', 'network']);
        expect(Svc.convertKdbxToDatabase(reloaded).root.entries[0].tags).toEqual(['Work', 'network']);
    });

    it('records a history revision when tags are the only change', async () => {
        const kdbxDb = await vault();
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        entry.tags = ['first'];
        await Svc.saveDatabase(Svc.saveEntry(database, Svc.prepareEntryForSave(entry), database.root, false)[0], kdbxDb);

        database = Svc.convertKdbxToDatabase(kdbxDb);
        const again = database.root.entries[0];
        expect(again.history).toHaveLength(1);
        again.tags = ['first', 'second'];
        await Svc.saveDatabase(Svc.saveEntry(database, Svc.prepareEntryForSave(again), database.root, false)[0], kdbxDb);

        const reloaded = await loadSaved(env);
        expect(theEntry(reloaded).tags).toEqual(['first', 'second']);
        expect(theEntry(reloaded).history).toHaveLength(2);
        // the revision holds what the tags were before this edit
        expect(Svc.convertKdbxToDatabase(reloaded).root.entries[0].history[1].tags).toEqual(['first']);
    });

    it('writes no revision when the tags did not really change', async () => {
        const kdbxDb = await vault();
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        entry.tags = ['Work'];
        await Svc.saveDatabase(Svc.saveEntry(database, Svc.prepareEntryForSave(entry), database.root, false)[0], kdbxDb);

        database = Svc.convertKdbxToDatabase(kdbxDb);
        const again = database.root.entries[0];
        // same tag, spelled with the whitespace and duplicate a form would allow
        again.tags = [' Work ', 'work'];
        await Svc.saveDatabase(Svc.saveEntry(database, again, database.root, false)[0], kdbxDb);

        expect(theEntry(await loadSaved(env)).history).toHaveLength(1);
    });

    it('collects every tag in use, ignoring the recycle bin', async () => {
        const kdbxDb = await vault();
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        database.root.entries[0].tags = ['zeta', 'alpha'];
        const binned = { ...Svc.createNewEntry(), id: 'x', title: 'Gone', tags: ['secret-bin-tag'] };
        database.root.groups.push({ id: 'bin', name: 'Recycle Bin', isRecycleBin: true, groups: [], entries: [binned] });

        expect(Svc.collectTags(database.root)).toEqual(['alpha', 'zeta']);
    });
});

import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

describe('recycle bin', () => {
    describe('database with an existing bin', () => {
        let kdbxDb: kdbxweb.Kdbx;

        beforeAll(async () => {
            // Kdbx.create pre-creates a recycle bin
            const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
            db0.setVersion(3);
            for (const t of ['Alpha', 'Beta']) {
                const e = db0.createEntry(db0.getDefaultGroup());
                e.fields.set('Title', t);
                e.fields.set('Password', kdbxweb.ProtectedValue.fromString(`pw-${t}`));
            }
            db0.createGroup(db0.getDefaultGroup(), 'Work');
            kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
        });

        it('marks the bin in the converted model', () => {
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            const bin = Svc.findRecycleBin(database.root);
            expect(bin).not.toBeNull();
            expect(bin!.name).toBe('Recycle Bin');
        });

        it('moves a deleted entry into the bin instead of dropping it', async () => {
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            const alpha = database.root.entries.find(e => e.title === 'Alpha')!;
            expect(Svc.isEntryInRecycleBin(database, alpha.id)).toBe(false);

            const updated = Svc.removeEntry(database, alpha);
            await Svc.saveDatabase(updated, kdbxDb);

            const reloaded = await loadSaved(env);
            expect(allTitles(reloaded)).toContain('Alpha');
            const binGroup = reloaded.getDefaultGroup().groups.find(g =>
                g.uuid.toString() === reloaded.meta.recycleBinUuid?.toString())!;
            expect(binGroup.entries.some(e => e.fields.get('Title') === 'Alpha')).toBe(true);
            kdbxDb = reloaded;
        });

        it('deletes permanently from inside the bin and records a deleted object', async () => {
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            // aggregate views exclude the bin, so look inside it directly
            expect(Svc.getAllEntriesFromGroup(database.root).some(e => e.title === 'Alpha')).toBe(false);
            const alpha = Svc.findRecycleBin(database.root)!.entries.find(e => e.title === 'Alpha')!;
            expect(Svc.isEntryInRecycleBin(database, alpha.id)).toBe(true);
            const alphaUuid = alpha.id;

            const updated = Svc.removeEntry(database, alpha);
            await Svc.saveDatabase(updated, kdbxDb);

            const reloaded = await loadSaved(env);
            expect(allTitles(reloaded)).not.toContain('Alpha');
            expect(reloaded.deletedObjects.some(d => d.uuid?.toString() === alphaUuid)).toBe(true);
            kdbxDb = reloaded;
        });

        it('moves a deleted group into the bin, then deletes it permanently from there', async () => {
            let database = Svc.convertKdbxToDatabase(kdbxDb);
            const work = database.root.groups.find(g => g.name === 'Work')!;
            expect(Svc.isGroupInRecycleBin(database, work)).toBe(false);
            await Svc.saveDatabase(Svc.removeGroup(database, work), kdbxDb);

            let reloaded = await loadSaved(env);
            const binGroup = reloaded.getDefaultGroup().groups.find(g =>
                g.uuid.toString() === reloaded.meta.recycleBinUuid?.toString())!;
            expect(binGroup.groups.some(g => g.name === 'Work')).toBe(true);

            database = Svc.convertKdbxToDatabase(reloaded);
            const bin = Svc.findRecycleBin(database.root)!;
            const workInBin = bin.groups.find(g => g.name === 'Work')!;
            expect(Svc.isGroupInRecycleBin(database, workInBin)).toBe(true);
            await Svc.saveDatabase(Svc.removeGroup(database, workInBin), reloaded);

            reloaded = await loadSaved(env);
            const binAfter = reloaded.getDefaultGroup().groups.find(g =>
                g.uuid.toString() === reloaded.meta.recycleBinUuid?.toString())!;
            expect(binAfter.groups.some(g => g.name === 'Work')).toBe(false);
        });
    });

    describe('bin follow-ups', () => {
        let kdbxDb: kdbxweb.Kdbx;

        beforeAll(async () => {
            const db0 = kdbxweb.Kdbx.create(cred(), 'Vault2');
            db0.setVersion(3);
            for (const t of ['Keep', 'Trash1', 'Trash2']) {
                const e = db0.createEntry(db0.getDefaultGroup());
                e.fields.set('Title', t);
                e.fields.set('Password', kdbxweb.ProtectedValue.fromString(`pw-${t}`));
            }
            kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

            let database = Svc.convertKdbxToDatabase(kdbxDb);
            for (const t of ['Trash1', 'Trash2']) {
                const entry = Svc.getEntriesForDisplay(database.root, database, '').find(e => e.title === t)
                    ?? database.root.entries.find(e => e.title === t)!;
                database = Svc.removeEntry(database, entry);
            }
            await Svc.saveDatabase(database, kdbxDb);
            kdbxDb = await loadSaved(env);
        });

        it('excludes bin contents from aggregate views and counts', () => {
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            const shown = Svc.getEntriesForDisplay(database.root, database, '').map(e => e.title);
            expect(shown).toContain('Keep');
            expect(shown).not.toContain('Trash1');
            expect(Svc.countEntriesInGroup(database.root)).toBe(1);
            // selecting the bin itself still shows its contents
            const bin = Svc.findRecycleBin(database.root)!;
            const binShown = Svc.getEntriesForDisplay(bin, database, '').map(e => e.title);
            expect(binShown).toEqual(expect.arrayContaining(['Trash1', 'Trash2']));
        });

        it('restores an entry by moving it out of the bin', async () => {
            const database = Svc.convertKdbxToDatabase(kdbxDb);
            const bin = Svc.findRecycleBin(database.root)!;
            const trash1 = bin.entries.find(e => e.title === 'Trash1')!;
            await Svc.saveDatabase(Svc.moveEntry(database, trash1, database.root), kdbxDb);

            const reloaded = await loadSaved(env);
            const model = Svc.convertKdbxToDatabase(reloaded);
            expect(model.root.entries.some(e => e.title === 'Trash1')).toBe(true);
            expect(Svc.isEntryInRecycleBin(model, model.root.entries.find(e => e.title === 'Trash1')!.id)).toBe(false);
            kdbxDb = reloaded;
        });

        it('empties the bin permanently and records deleted objects', async () => {
            let database = Svc.convertKdbxToDatabase(kdbxDb);
            const bin = Svc.findRecycleBin(database.root)!;
            expect(bin.entries.length).toBeGreaterThan(0);
            const trashedUuid = bin.entries[0].id;

            await Svc.saveDatabase(Svc.emptyRecycleBin(database), kdbxDb);

            const reloaded = await loadSaved(env);
            database = Svc.convertKdbxToDatabase(reloaded);
            const binAfter = Svc.findRecycleBin(database.root)!;
            expect(binAfter.entries).toHaveLength(0);
            expect(binAfter.groups).toHaveLength(0);
            expect(allTitles(reloaded)).not.toContain('Trash2');
            expect(reloaded.deletedObjects.some(d => d.uuid?.toString() === trashedUuid)).toBe(true);
        });
    });

    describe('database without a bin', () => {
        it('creates the bin on first delete and registers it in meta', async () => {
            const db0 = kdbxweb.Kdbx.create(cred(), 'NoBin');
            db0.setVersion(3);
            // simulate a foreign database with no recycle bin
            const preBin = db0.getDefaultGroup().groups.find(g =>
                g.uuid.toString() === db0.meta.recycleBinUuid?.toString());
            if (preBin) db0.getDefaultGroup().groups.splice(db0.getDefaultGroup().groups.indexOf(preBin), 1);
            db0.meta.recycleBinUuid = undefined;
            const e = db0.createEntry(db0.getDefaultGroup());
            e.fields.set('Title', 'Lonely');
            e.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
            const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

            const database = Svc.convertKdbxToDatabase(kdbxDb);
            expect(Svc.findRecycleBin(database.root)).toBeNull();
            const lonely = database.root.entries.find(en => en.title === 'Lonely')!;
            await Svc.saveDatabase(Svc.removeEntry(database, lonely), kdbxDb);

            const reloaded = await loadSaved(env);
            expect(reloaded.meta.recycleBinUuid).toBeDefined();
            const binGroup = reloaded.getDefaultGroup().groups.find(g =>
                g.uuid.toString() === reloaded.meta.recycleBinUuid!.toString())!;
            expect(binGroup.name).toBe('Recycle Bin');
            expect(binGroup.entries.some(en => en.fields.get('Title') === 'Lonely')).toBe(true);
        });
    });
});

describe('restoring to the original group', () => {
    // Deleting an entry records the group it came out of. Restore used to
    // ignore that and drop everything at the root, which on a vault with any
    // structure made the bin a one-way trip.
    //
    // kdbx only writes previousParentGroup to the file at 4.1, so a reopened
    // 4.0 vault has nothing to go on and keeps the old root fallback. Within a
    // session the field is on the in-memory object either way, and App re-reads
    // the model from that after every save, which is the path a user takes when
    // they delete something and immediately want it back
    const vaultWithGroups = async (minor = 0) => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Structured');
        db0.setVersion(4);
        // previousParentGroup is a 4.1 field, so the version is the point of
        // this fixture. AES rather than the Argon2 default only because the
        // test environment has no argon2 binding
        db0.header.versionMinor = minor;
        db0.header.setKdf(kdbxweb.Consts.KdfId.Aes);
        const work = db0.createGroup(db0.getDefaultGroup(), 'Work');
        const e = db0.createEntry(work);
        e.fields.set('Title', 'Payroll');
        e.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
        db0.createGroup(db0.getDefaultGroup(), 'Personal');
        return db0;
    };

    const trashedEntry = (database: ReturnType<typeof Svc.convertKdbxToDatabase>) =>
        Svc.findRecycleBin(database.root)!.entries.find(e => e.title === 'Payroll')!;

    it('sends a just-deleted entry back to the group it came from', async () => {
        const kdbxDb = await vaultWithGroups();
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.removeEntry(database, work.entries[0]), kdbxDb);

        // exactly what App does after a save: re-read from the live kdbx
        const after = Svc.convertKdbxToDatabase(kdbxDb);
        const trashed = trashedEntry(after);
        expect(trashed.previousParentGroup).toBe(work.id);
        expect(Svc.restoreTargetGroup(after, trashed).name).toBe('Work');
    });

    it('still knows the group after reopening a 4.1 vault', async () => {
        const kdbxDb = await vaultWithGroups(1);
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.removeEntry(database, work.entries[0]), kdbxDb);

        const after = Svc.convertKdbxToDatabase(await loadSaved(env));
        expect(Svc.restoreTargetGroup(after, trashedEntry(after)).name).toBe('Work');
    });

    it('falls back to the root after reopening a 4.0 vault, which cannot store it', async () => {
        const kdbxDb = await vaultWithGroups(0);
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.removeEntry(database, work.entries[0]), kdbxDb);

        const after = Svc.convertKdbxToDatabase(await loadSaved(env));
        expect(trashedEntry(after).previousParentGroup).toBeUndefined();
        expect(Svc.restoreTargetGroup(after, trashedEntry(after)).id).toBe(after.root.id);
    });

    it('falls back to the root when the original group is itself in the bin', async () => {
        const kdbxDb = await vaultWithGroups(1);
        let database = Svc.convertKdbxToDatabase(kdbxDb);
        const work = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.removeEntry(database, work.entries[0]), kdbxDb);

        database = Svc.convertKdbxToDatabase(kdbxDb);
        const staleWork = database.root.groups.find(g => g.name === 'Work')!;
        await Svc.saveDatabase(Svc.removeGroup(database, staleWork), kdbxDb);

        const after = Svc.convertKdbxToDatabase(kdbxDb);
        expect(Svc.restoreTargetGroup(after, trashedEntry(after)).id).toBe(after.root.id);
    });

    it('falls back to the root for an entry that never moved', async () => {
        const kdbxDb = await vaultWithGroups();
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const fresh = database.root.groups.find(g => g.name === 'Work')!.entries[0];
        expect(fresh.previousParentGroup).toBeUndefined();
        expect(Svc.restoreTargetGroup(database, fresh).id).toBe(database.root.id);
    });
});

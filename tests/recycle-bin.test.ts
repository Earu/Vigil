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
            const alpha = Svc.getAllEntriesFromGroup(database.root).find(e => e.title === 'Alpha')!;
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

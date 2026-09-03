import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, tick, MockEnv } from './helpers';

// convertKdbxToDatabase reuses the previous model object for an unchanged
// entry (the round-trip tests prove values stay correct; these pin the reuse
// itself and the invalidation edges the cache key has to cover).

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

async function freshVault(): Promise<kdbxweb.Kdbx> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const root = db0.getDefaultGroup();
    db0.createEntry(root).fields.set('Title', 'One');
    db0.createEntry(root).fields.set('Title', 'Two');
    db0.createGroup(root, 'Sub');
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 500;
    const db = await loadSaved(env);
    Svc.setPath('/fake.kdbx');
    await tick();
    return db;
}

describe('the converted-entry cache', () => {
    it('reuses model objects for unchanged entries across converts', async () => {
        const db = await freshVault();
        const first = Svc.convertKdbxToDatabase(db);
        const second = Svc.convertKdbxToDatabase(db);
        expect(second.root.entries[0]).toBe(first.root.entries[0]);
        expect(second.root.entries[1]).toBe(first.root.entries[1]);
    });

    it('rebuilds the edited entry and keeps the untouched one', async () => {
        const db = await freshVault();
        const before = Svc.convertKdbxToDatabase(db);

        const one = before.root.entries.find(e => e.title === 'One')!;
        const [edited] = Svc.saveEntry(before, Svc.prepareEntryForSave({ ...one, notes: 'changed' }), before.root, false);
        await Svc.saveDatabase(edited, db);

        const after = Svc.convertKdbxToDatabase(db);
        const oneAfter = after.root.entries.find(e => e.title === 'One')!;
        const twoAfter = after.root.entries.find(e => e.title === 'Two')!;
        expect(oneAfter).not.toBe(one);
        expect(oneAfter.notes).toBe('changed');
        // The edit pushed a history revision; the model carries it
        expect(oneAfter.history.length).toBe(one.history.length + 1);
        expect(twoAfter).toBe(before.root.entries.find(e => e.title === 'Two'));
    });

    it('rebuilds a moved entry so its location fields are current', async () => {
        const db = await freshVault();
        const before = Svc.convertKdbxToDatabase(db);
        const one = before.root.entries.find(e => e.title === 'One')!;
        const sub = before.root.groups.find(g => g.name === 'Sub')!;

        const moved = Svc.moveEntry(before, one, sub);
        await Svc.saveDatabase(moved, db);

        const after = Svc.convertKdbxToDatabase(db);
        const subAfter = after.root.groups.find(g => g.name === 'Sub')!;
        const oneAfter = subAfter.entries.find(e => e.title === 'One')!;
        // A move is a location change, not a field change; the model must
        // still be rebuilt so previousParentGroup is not stale
        expect(oneAfter.previousParentGroup).toBe(before.root.id);
        expect(after.root.entries.some(e => e.title === 'One')).toBe(false);
    });
});

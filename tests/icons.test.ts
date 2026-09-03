import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

// KeePass icons: the standard icon index and custom icon uuid ride the model
// through converts and saves, an icon change counts as an entry change, and
// custom icon bitmaps come out as data URLs for the UI.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function vaultWithIcons() {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const root = db.getDefaultGroup();

    const iconUuid = kdbxweb.KdbxUuid.random();
    db.meta.customIcons.set(iconUuid.toString(), { data: PNG_BYTES.slice().buffer, name: 'site' });

    const standard = db.createEntry(root);
    standard.fields.set('Title', 'Standard');
    standard.icon = kdbxweb.Consts.Icons.Settings;

    const custom = db.createEntry(root);
    custom.fields.set('Title', 'Custom');
    custom.customIcon = iconUuid;

    const group = db.createGroup(root, 'Homebanking');
    group.icon = kdbxweb.Consts.Icons.Homebanking;

    // kdbx stores times at second resolution; a fixture built and edited
    // inside the same second would hide the clock bumps under test
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (const item of root.allGroupsAndEntries()) {
        item.times.lastModTime = old;
        item.times.locationChanged = old;
    }

    env.disk.bytes = Buffer.from(await db.save());
    env.disk.mtime = 100;
    return { db: await loadSaved(env), iconUuid };
}

beforeEach(() => {
    env.disk.bytes = null;
    env.disk.mtime = 100;
});

describe('icon model plumbing', () => {
    it('carries standard and custom icons into the model', async () => {
        const { db, iconUuid } = await vaultWithIcons();
        const model = Svc.convertKdbxToDatabase(db);

        const standard = model.root.entries.find(e => e.title === 'Standard')!;
        expect(standard.icon).toBe(kdbxweb.Consts.Icons.Settings);
        expect(standard.customIcon).toBeUndefined();

        const custom = model.root.entries.find(e => e.title === 'Custom')!;
        expect(custom.customIcon).toBe(iconUuid.toString());
        // The file stores the default key icon as index 0; the model's
        // canonical "no choice" is undefined, so a no-op re-pick of the
        // default cannot read as an edit
        expect(custom.icon).toBeUndefined();

        const group = model.root.groups.find(g => g.name === 'Homebanking')!;
        expect(group.icon).toBe(kdbxweb.Consts.Icons.Homebanking);
    });

    it('serves custom icon bitmaps as data URLs', async () => {
        const { db, iconUuid } = await vaultWithIcons();
        Svc.convertKdbxToDatabase(db);
        const url = Svc.getCustomIconUrl(iconUuid.toString());
        expect(url).toMatch(/^data:image\/png;base64,/);
        expect(Svc.getCustomIconUrl('nonsense')).toBeUndefined();
    });

    it('keeps icons across an unrelated save', async () => {
        const { db, iconUuid } = await vaultWithIcons();
        Svc.setPath('/fake.kdbx');
        const model = Svc.convertKdbxToDatabase(db);
        const standard = model.root.entries.find(e => e.title === 'Standard')!;
        model.root.entries = model.root.entries.map(e =>
            e.id === standard.id ? { ...e, notes: 'edited' } : e);
        await Svc.saveDatabase(model, db);

        const saved = await loadSaved(env);
        const entries = [...saved.getDefaultGroup().allEntries()];
        expect(entries.find(e => e.fields.get('Title') === 'Standard')!.icon)
            .toBe(kdbxweb.Consts.Icons.Settings);
        expect(entries.find(e => e.fields.get('Title') === 'Custom')!.customIcon?.toString())
            .toBe(iconUuid.toString());
    });

    it('writes a group icon change from the model, bumping its clock', async () => {
        const { db, iconUuid } = await vaultWithIcons();
        Svc.setPath('/fake.kdbx');
        const model = Svc.convertKdbxToDatabase(db);
        const group = model.root.groups.find(g => g.name === 'Homebanking')!;
        const before = [...db.getDefaultGroup().groups]
            .find(g => g.name === 'Homebanking')!.times.lastModTime!.getTime();

        let updated = Svc.updateGroupMeta(model, group, { icon: kdbxweb.Consts.Icons.Money });
        await Svc.saveDatabase(updated, db);
        let saved = await loadSaved(env);
        let savedGroup = saved.getDefaultGroup().groups.find(g => g.name === 'Homebanking')!;
        expect(savedGroup.icon).toBe(kdbxweb.Consts.Icons.Money);
        expect(savedGroup.times.lastModTime!.getTime()).toBeGreaterThan(before);

        // A custom icon set on the group wins and round-trips too
        updated = Svc.updateGroupMeta(Svc.convertKdbxToDatabase(db), group, { customIcon: iconUuid.toString() });
        await Svc.saveDatabase(updated, db);
        saved = await loadSaved(env);
        savedGroup = saved.getDefaultGroup().groups.find(g => g.name === 'Homebanking')!;
        expect(savedGroup.customIcon?.toString()).toBe(iconUuid.toString());
    });

    it('keeps the recycle bin icon when the bin is created by a save', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        db.setVersion(3);
        const entry = db.createEntry(db.getDefaultGroup());
        entry.fields.set('Title', 'Doomed');
        env.disk.bytes = Buffer.from(await db.save());
        const loaded = await loadSaved(env);
        Svc.setPath('/fake.kdbx');

        // Deleting the entry creates the bin in the model; two saves in a
        // row must not flip its trash icon back to the folder default
        const model = Svc.convertKdbxToDatabase(loaded);
        const withBin = Svc.removeEntry(model, model.root.entries[0]);
        await Svc.saveDatabase(withBin, loaded);
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(loaded), loaded);

        const saved = await loadSaved(env);
        const bin = saved.getDefaultGroup().groups
            .find(g => g.uuid.toString() === saved.meta.recycleBinUuid?.toString())!;
        expect(bin.icon).toBe(kdbxweb.Consts.Icons.TrashBin);
    });

    it('writes staged custom icons the model references, and only those', async () => {
        const { db } = await vaultWithIcons();
        Svc.setPath('/fake.kdbx');
        const model = Svc.convertKdbxToDatabase(db);

        const used = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 5, 5]);
        const usedId = Svc.stageCustomIcon(used);
        const orphanId = Svc.stageCustomIcon(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 7, 7]));
        // Staged icons are renderable before any save
        expect(Svc.getCustomIconUrl(usedId)).toMatch(/^data:image\/png/);
        // Identical bytes collapse onto the id already staged
        expect(Svc.stageCustomIcon(used.slice())).toBe(usedId);

        const standard = model.root.entries.find(e => e.title === 'Standard')!;
        model.root.entries = model.root.entries.map(e =>
            e.id === standard.id ? { ...e, customIcon: usedId } : e);
        await Svc.saveDatabase(model, db);

        const saved = await loadSaved(env);
        expect(new Uint8Array(saved.meta.customIcons.get(usedId)!.data)).toEqual(used);
        expect(saved.meta.customIcons.has(orphanId)).toBe(false);
        expect([...saved.getDefaultGroup().allEntries()]
            .find(e => e.fields.get('Title') === 'Standard')!.customIcon?.toString()).toBe(usedId);
    });

    it('round-trips the favicon opt-out through entry customData (kdbx4)', async () => {
        const db4 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db4.setVersion(4);
        db4.header.setKdf(kdbxweb.Consts.KdfId.Aes);
        const entry = db4.createEntry(db4.getDefaultGroup());
        entry.fields.set('Title', 'Site');
        entry.times.lastModTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        env.disk.bytes = Buffer.from(await db4.save());
        const loaded = await loadSaved(env);
        Svc.setPath('/fake.kdbx');

        const model = Svc.convertKdbxToDatabase(loaded);
        model.root.entries = model.root.entries.map(e => ({ ...e, suppressFavicon: true }));
        await Svc.saveDatabase(model, loaded);

        let saved = await loadSaved(env);
        let savedEntry = [...saved.getDefaultGroup().allEntries()][0];
        expect(savedEntry.customData?.get('Vigil_NoFavicon')?.value).toBe('true');
        // And the model built from the file carries it back
        expect(Svc.convertKdbxToDatabase(loaded).root.entries[0].suppressFavicon).toBe(true);

        // Clearing the flag removes the key
        const cleared = Svc.convertKdbxToDatabase(loaded);
        cleared.root.entries = cleared.root.entries.map(e => ({ ...e, suppressFavicon: undefined }));
        await Svc.saveDatabase(cleared, loaded);
        saved = await loadSaved(env);
        savedEntry = [...saved.getDefaultGroup().allEntries()][0];
        expect(savedEntry.customData?.get('Vigil_NoFavicon')).toBeUndefined();
    });

    it('writes an icon change from the model and records a revision', async () => {
        const { db } = await vaultWithIcons();
        Svc.setPath('/fake.kdbx');
        const model = Svc.convertKdbxToDatabase(db);
        const standard = model.root.entries.find(e => e.title === 'Standard')!;
        const before = [...db.getDefaultGroup().allEntries()]
            .find(e => e.fields.get('Title') === 'Standard')!.history.length;
        model.root.entries = model.root.entries.map(e =>
            e.id === standard.id ? { ...e, icon: kdbxweb.Consts.Icons.Star } : e);
        await Svc.saveDatabase(model, db);

        const saved = await loadSaved(env);
        const savedEntry = [...saved.getDefaultGroup().allEntries()]
            .find(e => e.fields.get('Title') === 'Standard')!;
        expect(savedEntry.icon).toBe(kdbxweb.Consts.Icons.Star);
        expect(savedEntry.history.length).toBe(before + 1);
    });
});

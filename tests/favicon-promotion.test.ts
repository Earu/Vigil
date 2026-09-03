import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

// Favicon promotion: a fetched favicon is stored into the vault as a custom
// icon; entries sharing a host share the stored icon; a host is attempted
// once per session whichever way the fetch goes; nothing runs with the
// favicon setting off.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { FaviconService } = await import('../src/services/FaviconService');
const { userSettingsService } = await import('../src/services/UserSettingsService');

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

const fetchFavicon = vi.fn(async (host: string) => {
    if (host === 'dead.example.com') return { success: false, error: 'No favicon (status 404)' };
    return { success: true, data: PNG_BYTES.slice() };
});

async function vaultWithUrls() {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const root = db.getDefaultGroup();
    const one = db.createEntry(root);
    one.fields.set('Title', 'One');
    one.fields.set('URL', 'https://site.example.com/login');
    const two = db.createEntry(root);
    two.fields.set('Title', 'Two');
    two.fields.set('URL', 'https://www.site.example.com');
    const dead = db.createEntry(root);
    dead.fields.set('Title', 'Dead');
    dead.fields.set('URL', 'https://dead.example.com');
    const bare = db.createEntry(root);
    bare.fields.set('Title', 'NoUrl');

    env.disk.bytes = Buffer.from(await db.save());
    env.disk.mtime = 100;
    return await loadSaved(env);
}

beforeEach(() => {
    env.disk.bytes = null;
    env.disk.mtime = 100;
    fetchFavicon.mockClear();
    FaviconService.reset();
    userSettingsService.setFetchFavicons(true);
    (globalThis as any).window.electron.fetchFavicon = fetchFavicon;
});

describe('favicon promotion', () => {
    it('stores fetched favicons as shared custom icons and saves once', async () => {
        const db = await vaultWithUrls();
        const model = Svc.convertKdbxToDatabase(db);
        const save = vi.fn(async () => {});

        await FaviconService.sweep(db, model, save);

        // www. is stripped, so both live entries share one host and one icon
        expect(fetchFavicon.mock.calls.map(c => c[0]).sort())
            .toEqual(['dead.example.com', 'site.example.com']);
        expect(db.meta.customIcons.size).toBe(1);
        const [iconId, icon] = [...db.meta.customIcons][0];
        expect(new Uint8Array(icon.data)).toEqual(PNG_BYTES);

        const entries = [...db.getDefaultGroup().allEntries()];
        const one = entries.find(e => e.fields.get('Title') === 'One')!;
        const two = entries.find(e => e.fields.get('Title') === 'Two')!;
        expect(one.customIcon?.toString()).toBe(iconId);
        expect(two.customIcon?.toString()).toBe(iconId);
        // The pre-icon state is in history, so a merge losing to the bumped
        // timestamp still holds it
        expect(one.history.length).toBe(1);
        expect(entries.find(e => e.fields.get('Title') === 'Dead')!.customIcon).toBeUndefined();
        expect(entries.find(e => e.fields.get('Title') === 'NoUrl')!.customIcon).toBeUndefined();
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('attempts each host once per session, success and failure alike', async () => {
        const db = await vaultWithUrls();
        const save = vi.fn(async () => {});
        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), save);
        fetchFavicon.mockClear();

        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), save);
        expect(fetchFavicon).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('does nothing with the favicon setting off', async () => {
        userSettingsService.setFetchFavicons(false);
        const db = await vaultWithUrls();
        const save = vi.fn(async () => {});
        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), save);
        expect(fetchFavicon).not.toHaveBeenCalled();
        expect(db.meta.customIcons.size).toBe(0);
        expect(save).not.toHaveBeenCalled();
    });

    it('skips entries whose favicon icon the user removed', async () => {
        const db = await vaultWithUrls();
        const one = [...db.getDefaultGroup().allEntries()].find(e => e.fields.get('Title') === 'One')!;
        one.customData = new Map([['Vigil_NoFavicon', { value: 'true' }]]);
        one.times.lastModTime = new Date(Date.now() + 1000);

        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), vi.fn(async () => {}));
        expect(one.customIcon).toBeUndefined();
        // The shared host is still fetched for the other entry on it
        const two = [...db.getDefaultGroup().allEntries()].find(e => e.fields.get('Title') === 'Two')!;
        expect(two.customIcon).toBeDefined();
    });

    it('stops dead when reset (lock) lands mid-sweep', async () => {
        const db = await vaultWithUrls();
        const save = vi.fn(async () => {});
        // The lock arrives while the first fetch is in flight
        fetchFavicon.mockImplementationOnce(async () => {
            FaviconService.reset();
            return { success: true, data: PNG_BYTES.slice() };
        });

        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), save);
        expect(db.meta.customIcons.size).toBe(0);
        for (const entry of db.getDefaultGroup().allEntries()) {
            expect(entry.customIcon).toBeUndefined();
        }
        expect(save).not.toHaveBeenCalled();
    });

    it('backs off while blocked and hands the hosts back for later', async () => {
        const db = await vaultWithUrls();
        const save = vi.fn(async () => {});
        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), save, () => true);
        expect(db.meta.customIcons.size).toBe(0);
        expect(save).not.toHaveBeenCalled();

        // The blocked pass must not burn the once-per-session guard
        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), save, () => false);
        expect(db.meta.customIcons.size).toBe(1);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('reuses an existing custom icon holding the same bytes', async () => {
        const db = await vaultWithUrls();
        const existing = kdbxweb.KdbxUuid.random();
        db.meta.customIcons.set(existing.toString(), { data: PNG_BYTES.slice().buffer, name: 'old' });

        await FaviconService.sweep(db, Svc.convertKdbxToDatabase(db), vi.fn(async () => {}));
        expect(db.meta.customIcons.size).toBe(1);
        const one = [...db.getDefaultGroup().allEntries()].find(e => e.fields.get('Title') === 'One')!;
        expect(one.customIcon?.toString()).toBe(existing.toString());
    });
});

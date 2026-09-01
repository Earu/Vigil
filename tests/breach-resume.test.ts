import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Entry, Group } from '../src/types/database';
import { installMockWindow } from './helpers';

const backing = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => backing.set(k, v),
    removeItem: (k: string) => backing.delete(k),
};

installMockWindow();

const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');
const { HaveIBeenPwnedService } = await import('../src/services/HaveIBeenPwnedService');
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');

const DB = '/resume.kdbx';
const strong = { score: 4, feedback: { warning: '', suggestions: [] } };

const entry = (id: string): Entry => ({
    id,
    title: id,
    username: `${id}@example.com`,
    password: `pw-${id}`,
    created: new Date(0),
    modified: new Date(0),
    attachments: [],
    history: [],
    expires: false,
    customFields: [],
});

// checkGroup treats this name as the root of a sweep
const vault = (ids: string[]): Group =>
    ({ id: 'root', name: 'All Entries', groups: [], entries: ids.map(entry) });

describe('resuming an interrupted breach sweep', () => {
    beforeEach(() => {
        BreachStatusStore.clearAll();
        vi.restoreAllMocks();
        // findBreachedAndWeakEntries reads the open vault path from the service
        KeepassDatabaseService.setPath(DB);
    });

    it('only looks up the entries that have no cached verdict', async () => {
        const lookups: string[] = [];
        vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockImplementation(async (password: string) => {
            lookups.push(password);
            return { isPwned: false, pwnedCount: 0, strength: strong };
        });

        // A sweep that got through three of five entries before the app closed
        for (const id of ['a', 'b', 'c']) {
            BreachStatusStore.setEntryStatus(DB, id, { isPwned: false, count: 0, strength: strong });
        }
        BreachStatusStore.flush();

        await BreachCheckService.checkGroup(DB, vault(['a', 'b', 'c', 'd', 'e']));

        expect(lookups.sort()).toEqual(['pw-d', 'pw-e']);
    });

    it('reports the whole vault as still needing work while any entry is uncached', () => {
        const root = vault(['a', 'b', 'c']);
        BreachStatusStore.setEntryStatus(DB, 'a', { isPwned: false, count: 0, strength: strong });
        BreachStatusStore.flush();

        // What PasswordForm.startBreachCheck consults to decide whether to
        // run a sweep at all on the next unlock
        const partial = BreachCheckService.findBreachedAndWeakEntries(root);
        expect(partial.hasCheckedEntries).toBe(true);
        expect(partial.allEntriesCached).toBe(false);

        for (const id of ['b', 'c']) {
            BreachStatusStore.setEntryStatus(DB, id, { isPwned: false, count: 0, strength: strong });
        }
        BreachStatusStore.flush();
        expect(BreachCheckService.findBreachedAndWeakEntries(root).allEntriesCached).toBe(true);
    });

    it('keeps what the sweep learned when the vault is locked mid-check', async () => {
        vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockResolvedValue({
            isPwned: true, pwnedCount: 42, strength: strong,
        });

        await BreachCheckService.checkEntry(DB, entry('a'));
        // Lock: App.handleLock calls this while the coalesced write is pending
        BreachCheckService.cancelChecks();

        expect(JSON.parse(backing.get('breach_status_store')!)[DB]['a'].count).toBe(42);
    });

    it('re-checks an entry whose cached verdict has aged out', async () => {
        let lookups = 0;
        vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockImplementation(async () => {
            lookups++;
            return { isPwned: false, pwnedCount: 0, strength: strong };
        });

        BreachStatusStore.setEntryStatus(DB, 'a', { isPwned: false, count: 0, strength: strong });
        BreachStatusStore.flush();

        // 24h cache window, so a resume a day later starts over
        const aged = JSON.parse(backing.get('breach_status_store')!);
        aged[DB]['a'].timestamp = Date.now() - 25 * 60 * 60 * 1000;
        backing.set('breach_status_store', JSON.stringify(aged));
        BreachStatusStore.clearAll();
        backing.set('breach_status_store', JSON.stringify(aged));

        await BreachCheckService.checkGroup(DB, vault(['a']));
        expect(lookups).toBe(1);
    });
});

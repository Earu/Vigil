import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMockWindow } from './helpers';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
};

const env = installMockWindow();
void env;
let apiCalls: string[] = [];
let failCalls = false;
(globalThis as any).window.electron.checkEmailBreaches = async (email: string) => {
    apiCalls.push(email);
    if (failCalls) throw new Error('429');
    if (email === 'breached@example.com') return [{ Name: 'X', BreachDate: '2099-01-01' }];
    if (email === 'old-breach@example.com') return [{ Name: 'Old', BreachDate: '2022-06-01' }];
    return [];
};

const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { EmailBreachStatusStore } = await import('../src/services/EmailBreachStatusStore');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');
const { HaveIBeenPwnedService } = await import('../src/services/HaveIBeenPwnedService');
const { userSettingsService } = await import('../src/services/UserSettingsService');
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');

userSettingsService.setHibpApiKey('test-key');
(BreachCheckService as any).EMAIL_REQUEST_DELAY = 0;

const entry = (id: string, username: string, modified = '2020-01-01') => ({
    id, username, title: id,
    password: 'x', modified: new Date(modified),
} as any);

const rootGroup = (entries: any[]) => ({ name: 'All Entries', entries, groups: [] } as any);

beforeEach(() => {
    store.clear();
    apiCalls = [];
    failCalls = false;
});

describe('email breach sweep', () => {
    it('checks each unique email once, not once per entry', async () => {
        const group = rootGroup([
            entry('a', 'shared@example.com'),
            entry('b', 'shared@example.com'),
            entry('c', 'shared@example.com'),
            entry('d', 'other@example.com'),
            entry('e', 'not-an-email'),
        ]);
        await BreachCheckService.checkGroupEmails('/db1.kdbx', group);
        expect(apiCalls.sort()).toEqual(['other@example.com', 'shared@example.com']);
        // every same-email entry still got its own cached status
        expect(EmailBreachStatusStore.getEntryEmailStatus('/db1.kdbx', 'a', 'shared@example.com')).toEqual([]);
        expect(EmailBreachStatusStore.getEntryEmailStatus('/db1.kdbx', 'b', 'shared@example.com')).toEqual([]);
    });

    it('reports breached emails through the dedup path', async () => {
        const group = rootGroup([entry('breach-entry', 'breached@example.com')]);
        const hasBreached = await BreachCheckService.checkGroupEmails('/db2.kdbx', group);
        expect(hasBreached).toBe(true);
    });

    it('judges each entry sharing an address by its own last change', async () => {
        // One address, a breach in 2022, one entry changed after it and one
        // before. The first entry checked used to cache its own narrowed
        // list under the address, so the second read an all-clear
        const group = rootGroup([
            entry('recent', 'old-breach@example.com', '2025-01-01'),
            entry('stale', 'old-breach@example.com', '2019-01-01'),
        ]);
        await BreachCheckService.checkGroupEmails('/db4.kdbx', group);
        expect(apiCalls).toEqual(['old-breach@example.com']);

        // The report reads the cache of the vault that is open
        KeepassDatabaseService.setPath('/db4.kdbx');
        const report = BreachCheckService.findBreachedEmails(group);
        expect(report.breached.map(b => b.entry.id)).toEqual(['stale']);
        expect(report.breached[0].count).toBe(1);

        const recent = group.entries[0];
        const stale = group.entries[1];
        expect(EmailBreachStatusStore.getEntryEmailStatus('/db4.kdbx', recent.id, recent.username, recent.modified)).toEqual([]);
        expect(EmailBreachStatusStore.getEntryEmailStatus('/db4.kdbx', stale.id, stale.username, stale.modified)).toHaveLength(1);
    });

    it('does not fabricate a password verdict for an unchecked entry', async () => {
        // An email hit landing before the password sweep used to write
        // {isPwned: false, score: 0}; checkEntry then took it as a cache
        // hit and skipped the real HIBP check for the whole TTL
        const group = rootGroup([entry('e1', 'breached@example.com')]);
        await BreachCheckService.checkGroupEmails('/db5.kdbx', group);
        expect(BreachStatusStore.getEntryStatus('/db5.kdbx', 'e1')).toBeNull();

        // the password check still runs and picks up the email flag itself
        const spy = vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockResolvedValue({
            isPwned: true, pwnedCount: 3,
            strength: { score: 4, feedback: { warning: '', suggestions: [] } },
        });
        expect(await BreachCheckService.checkEntry('/db5.kdbx', group.entries[0])).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        const status = BreachStatusStore.getEntryStatus('/db5.kdbx', 'e1');
        expect(status?.isPwned).toBe(true);
        expect(status?.strength?.score).toBe(4);
        expect(status?.breachedEmail).toBe(true);
        spy.mockRestore();
    });

    it('merges the email flag into an existing password verdict', async () => {
        BreachStatusStore.setEntryStatus('/db6.kdbx', 'e1', {
            isPwned: false, count: 0,
            strength: { score: 3, feedback: { warning: '', suggestions: [] } },
        });
        const group = rootGroup([entry('e1', 'breached@example.com')]);
        await BreachCheckService.checkGroupEmails('/db6.kdbx', group);
        const status = BreachStatusStore.getEntryStatus('/db6.kdbx', 'e1');
        expect(status?.breachedEmail).toBe(true);
        expect(status?.strength?.score).toBe(3);
    });

    it('does not cache a failed lookup as all-clear', async () => {
        failCalls = true;
        const group = rootGroup([entry('fail-entry', 'fail@example.com')]);
        await BreachCheckService.checkGroupEmails('/db3.kdbx', group);
        expect(EmailBreachStatusStore.getEntryEmailStatus('/db3.kdbx', 'fail-entry', 'fail@example.com')).toBeNull();

        // next sweep retries and caches the good result
        failCalls = false;
        await BreachCheckService.checkGroupEmails('/db3.kdbx', group);
        expect(apiCalls).toHaveLength(2);
        expect(EmailBreachStatusStore.getEntryEmailStatus('/db3.kdbx', 'fail-entry', 'fail@example.com')).toEqual([]);
    });
});

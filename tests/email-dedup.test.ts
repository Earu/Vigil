import { describe, it, expect, beforeEach } from 'vitest';
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
    return email === 'breached@example.com'
        ? [{ Name: 'X', BreachDate: '2099-01-01' }]
        : [];
};

const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { EmailBreachStatusStore } = await import('../src/services/EmailBreachStatusStore');
const { userSettingsService } = await import('../src/services/UserSettingsService');

userSettingsService.setHibpApiKey('test-key');
(BreachCheckService as any).EMAIL_REQUEST_DELAY = 0;

const entry = (id: string, username: string) => ({
    id, username, title: id,
    password: 'x', modified: new Date('2020-01-01'),
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

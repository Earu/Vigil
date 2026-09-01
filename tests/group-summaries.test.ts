import { describe, it, expect, beforeEach } from 'vitest';
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
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');

const DB = '/summaries.kdbx';

const entry = (id: string, password = 'pw'): Entry => ({
    id,
    title: id,
    username: `${id}@example.com`,
    password,
    created: new Date(0),
    modified: new Date(0),
    attachments: [],
    history: [],
    expires: false,
    customFields: [],
});

const group = (id: string, entries: Entry[], groups: Group[] = []): Group =>
    ({ id, name: id, entries, groups });

const strong = { score: 4, feedback: { warning: '', suggestions: [] } };
const weak = { score: 1, feedback: { warning: 'too short', suggestions: [] } };

describe('group summaries', () => {
    beforeEach(() => {
        BreachStatusStore.clearAll();
        KeepassDatabaseService.setPath(DB);
    });

    it('counts entries the way the sidebar used to, excluding the recycle bin from parents', () => {
        const bin: Group = { ...group('bin', [entry('deleted-1'), entry('deleted-2')]), isRecycleBin: true };
        const child = group('child', [entry('c1'), entry('c2')]);
        const root = group('root', [entry('r1')], [child, bin]);

        const summaries = BreachCheckService.buildGroupSummaries(root);
        expect(summaries.get('root')!.entryCount).toBe(3);
        expect(summaries.get('child')!.entryCount).toBe(2);
        // The bin's own row still shows what is inside it
        expect(summaries.get('bin')!.entryCount).toBe(2);
        expect(summaries.get('root')!.entryCount)
            .toBe(KeepassDatabaseService.countEntriesInGroup(root));
    });

    it('propagates a breached entry up every ancestor and no further', () => {
        const deep = group('deep', [entry('bad')]);
        const child = group('child', [], [deep]);
        const sibling = group('sibling', [entry('fine')]);
        const root = group('root', [], [child, sibling]);

        BreachStatusStore.setEntryStatus(DB, 'bad', { isPwned: true, count: 3, strength: strong });
        BreachStatusStore.setEntryStatus(DB, 'fine', { isPwned: false, count: 0, strength: strong });

        const summaries = BreachCheckService.buildGroupSummaries(root);
        expect(summaries.get('deep')!.breached).toBe(true);
        expect(summaries.get('child')!.breached).toBe(true);
        expect(summaries.get('root')!.breached).toBe(true);
        expect(summaries.get('sibling')!.breached).toBe(false);
    });

    it('flags weak passwords and exposed emails separately from breaches', () => {
        const root = group('root', [entry('weak-one'), entry('exposed')]);
        BreachStatusStore.setEntryStatus(DB, 'weak-one', { isPwned: false, count: 0, strength: weak });
        BreachStatusStore.setEntryStatus(DB, 'exposed', { isPwned: false, count: 0, strength: strong, breachedEmail: true });

        const summary = BreachCheckService.buildGroupSummaries(root).get('root')!;
        expect(summary.breached).toBe(false);
        expect(summary.weak).toBe(true);
        expect(summary.breachedEmail).toBe(true);
    });

    it('ignores a stale password verdict on an entry that has no password', () => {
        const root = group('root', [{ ...entry('passkey-only'), password: '' }]);
        // What a cached status from before the passkey replaced the password
        // would look like; the email flag on it is still meaningful
        BreachStatusStore.setEntryStatus(DB, 'passkey-only', {
            isPwned: true, count: 5, strength: weak, breachedEmail: true,
        });

        const summary = BreachCheckService.buildGroupSummaries(root).get('root')!;
        expect(summary.breached).toBe(false);
        expect(summary.weak).toBe(false);
        expect(summary.breachedEmail).toBe(true);
    });

    it('returns an entry for every group even with no statuses cached', () => {
        const child = group('child', [entry('c1')]);
        const root = group('root', [], [child]);

        const summaries = BreachCheckService.buildGroupSummaries(root);
        expect([...summaries.keys()].sort()).toEqual(['child', 'root']);
        expect(summaries.get('root')).toEqual({ breached: false, weak: false, breachedEmail: false, entryCount: 1 });
    });
});

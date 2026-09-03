import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow } from './helpers';
import { Entry, Group } from '../src/types/database';

// Reference-valued passwords in the security report: never hashed or scored
// as literal text, excluded from reuse clustering (a reference IS the
// sanctioned way to share a password), and inheriting the verdict of the
// entry they point at.

installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');
const { PlaceholderService } = await import('../src/services/PlaceholderService');

const DB_PATH = '/db.kdbx';

function makeEntry(over: Partial<Entry>): Entry {
    return {
        id: kdbxweb.KdbxUuid.random().toString(),
        title: '', username: '', password: '',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
        ...over,
    };
}

const hexOf = (id: string) => [...kdbxweb.ByteUtils.base64ToBytes(id)]
    .map(b => b.toString(16).padStart(2, '0')).join('');

const target = makeEntry({ title: 'Origin', password: 'shared-secret' });
const referrer = makeEntry({ title: 'Alias', password: `{REF:P@I:${hexOf(target.id)}}` });
const root: Group = { id: 'root', name: 'Root', groups: [], entries: [target, referrer] };

beforeEach(() => {
    Svc.setPath(DB_PATH);
    PlaceholderService.setModelRoot(root);
});
afterEach(() => {
    PlaceholderService.setModelRoot(null);
    Svc.setPath(undefined);
});

describe('reference passwords in the security report', () => {
    it('skips hashing and scoring the literal reference text', async () => {
        // Any network call would throw in this environment; resolving at all
        // proves HIBP never saw the token, and the stored status is neutral
        const result = await BreachCheckService.checkEntry(DB_PATH, referrer);
        expect(result).toBe(false);
        const status = BreachStatusStore.getEntryStatus(DB_PATH, referrer.id);
        expect(status?.isPwned).toBe(false);
        expect(status?.strength).toBeNull();
    });

    it('inherits the breached and weak verdicts from the referenced entry', () => {
        BreachStatusStore.setEntryStatus(DB_PATH, target.id, {
            isPwned: true, count: 42,
            strength: { score: 1, feedback: { warning: '', suggestions: [] } },
        });
        BreachStatusStore.setEntryStatus(DB_PATH, referrer.id, { isPwned: false, count: 0, strength: null });

        const { breached, weak } = BreachCheckService.findBreachedAndWeakEntries(root);
        expect(breached.map(b => b.entry.id).sort()).toEqual([target.id, referrer.id].sort());
        expect(breached.find(b => b.entry.id === referrer.id)?.count).toBe(42);
        expect(weak.map(w => w.entry.id).sort()).toEqual([target.id, referrer.id].sort());
    });

    it('drops the inherited flags when the target is clean', () => {
        BreachStatusStore.setEntryStatus(DB_PATH, target.id, {
            isPwned: false, count: 0,
            strength: { score: 4, feedback: { warning: '', suggestions: [] } },
        });
        const { breached, weak } = BreachCheckService.findBreachedAndWeakEntries(root);
        expect(breached).toHaveLength(0);
        expect(weak).toHaveLength(0);
    });

    it('keeps references out of reuse clusters', () => {
        const secondReferrer = makeEntry({ title: 'Alias2', password: `{REF:P@I:${hexOf(target.id)}}` });
        const reuseRoot: Group = { id: 'root', name: 'Root', groups: [], entries: [target, referrer, secondReferrer] };
        // Two referrers share the same literal token and the target's real
        // password; none of that is reuse the user should be told to fix
        expect(BreachCheckService.findReusedPasswords(reuseRoot)).toHaveLength(0);
    });
});

describe('search over references', () => {
    it('matches the resolved text a reference shows in the list', () => {
        const hub = makeEntry({ title: 'Hub', username: 'real-user' });
        const alias = makeEntry({ title: 'Shortcut', username: '{REF:U@T:Hub}' });
        const searchRoot: Group = { id: 'root', name: 'Root', groups: [], entries: [hub, alias] };
        PlaceholderService.setModelRoot(searchRoot);

        const hits = Svc.filterEntries([hub, alias], 'real-user');
        expect(hits.map(e => e.title).sort()).toEqual(['Hub', 'Shortcut']);
        // Raw token text still matches too
        expect(Svc.filterEntries([alias], '{REF:U@T').map(e => e.title)).toEqual(['Shortcut']);
    });
});

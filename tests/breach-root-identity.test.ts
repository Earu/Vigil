import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Entry, Group } from '../src/types/database';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

// checkGroup decides "this is the sweep's root" by name (group.name ===
// 'All Entries', lines 286 and 568), the synthetic label the database
// service gives the root model group. A user's real group named 'All
// Entries' passes the same test, so reaching it mid-walk re-runs the root
// setup: countedEntries is cleared, progress restarts at 0 with the
// subgroup's total, and finishing the subgroup zeroes progress and fires
// the completion toast while the sweep is still running. The root must be
// identified by id (database.root.id), never by name.
//
// Note the cancellation flag itself survives the collision: isCancelled is
// checked after the entry pool (line 308) and before every subgroup
// recursion (line 314), and the path from a passed guard to
// resetCancellation is synchronous, so a cancelled walk stops before it
// can reach the imposter. The second test pins that.

class FakeStorage {
    getItem(key: string): string | null {
        return Object.prototype.hasOwnProperty.call(this, key) ? (this as any)[key] : null;
    }
    setItem(key: string, value: string): void { (this as any)[key] = String(value); }
    removeItem(key: string): void { delete (this as any)[key]; }
}

(globalThis as any).localStorage = new FakeStorage();

installMockWindow();

const { BreachCacheCrypto } = await import('../src/services/BreachCacheCrypto');
const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');
const { HaveIBeenPwnedService } = await import('../src/services/HaveIBeenPwnedService');
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');

const DB = '/root-identity.kdbx';
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

const group = (id: string, name: string, ids: string[], groups: Group[] = []): Group =>
    ({ id, name, groups, entries: ids.map(entry) });

// Every HIBP lookup blocks until the test releases it, so the test can
// observe the sweep at exact points of the walk
let started: string[] = [];
let pending: Map<string, () => void>;

const armSlowHibp = () => {
    started = [];
    pending = new Map();
    vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockImplementation(async (password: string) => {
        started.push(password);
        await new Promise<void>(resolve => pending.set(password, resolve));
        return { isPwned: false, pwnedCount: 0, strength: strong };
    });
};

const release = (password: string) => {
    pending.get(password)!();
    pending.delete(password);
};

const untilStarted = async (password: string) => {
    while (!started.includes(password)) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
};

describe('sweep root identified by id, not by name', () => {
    beforeEach(() => {
        BreachCacheCrypto.unlock(kdbxweb.Kdbx.create(cred(), 'RootIdentity'));
        BreachStatusStore.clearAll();
        vi.restoreAllMocks();
        KeepassDatabaseService.setPath(DB);
    });

    it('keeps the progress counters across a subgroup named All Entries', async () => {
        armSlowHibp();

        // The user's own group, named exactly like the synthetic root label
        const imposter = group('imposter', 'All Entries', ['c', 'd']);
        const root = group('root', 'All Entries', ['a', 'b'], [imposter]);

        const sweep = BreachCheckService.checkGroup(DB, root);

        // Root entries in flight: 0 of 4 done
        await untilStarted('pw-a');
        await untilStarted('pw-b');
        const atRoot = { ...BreachCheckService.getProgress().passwords };

        // Finish the root entries; the walk descends into the imposter
        release('pw-a');
        release('pw-b');
        await untilStarted('pw-c');
        const insideImposter = { ...BreachCheckService.getProgress().passwords };

        release('pw-c');
        release('pw-d');
        await sweep;

        expect(atRoot).toEqual({ checked: 0, total: 4 });
        // The imposter is an ordinary subgroup: two entries done, four total.
        // Today the name match re-runs the root setup and reports 0 of 2
        expect(insideImposter).toEqual({ checked: 2, total: 4 });
    });

    it('stays cancelled on the way to a subgroup named All Entries', async () => {
        started = [];
        let releaseA!: () => void;
        vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockImplementation(async (password: string) => {
            started.push(password);
            if (password === 'pw-a') {
                await new Promise<void>(resolve => { releaseA = resolve; });
            }
            return { isPwned: false, pwnedCount: 0, strength: strong };
        });

        const imposter = group('imposter', 'All Entries', ['c']);
        const root = group('root', 'All Entries', ['a'], [imposter]);

        const sweep = BreachCheckService.checkGroup(DB, root);
        await untilStarted('pw-a');

        // The lock path
        BreachCheckService.cancelChecks();
        releaseA();

        expect(await sweep).toBe(false);
        // The cancelled walk never reaches the imposter, so nothing there is
        // looked up and the collision cannot re-arm the sweep
        expect(started).toEqual(['pw-a']);
    });
});

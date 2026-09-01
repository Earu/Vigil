import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Counts what actually reaches storage, which is the point of the coalescing:
// a sweep over a large vault used to re-serialize the whole store per entry
const backing = new Map<string, string>();
const writes = { set: 0, remove: 0 };
(globalThis as any).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.set++; backing.set(k, v); },
    removeItem: (k: string) => { writes.remove++; backing.delete(k); },
};

const { BreachStatusStore } = await import('../src/services/BreachStatusStore');

const status = { isPwned: false, count: 0, strength: { score: 4, feedback: { warning: '', suggestions: [] } } };

vi.useFakeTimers();
afterAll(() => vi.useRealTimers());

describe('breach status store write coalescing', () => {
    beforeEach(() => {
        BreachStatusStore.clearAll();
        writes.set = 0;
        writes.remove = 0;
    });

    it('persists a burst of statuses once instead of once per entry', () => {
        for (let i = 0; i < 50; i++) {
            BreachStatusStore.setEntryStatus('/db.kdbx', `entry-${i}`, status);
        }
        expect(writes.set).toBe(0);

        vi.advanceTimersByTime(250);
        expect(writes.set).toBe(1);
        expect(JSON.parse(backing.get('breach_status_store')!)['/db.kdbx']).toHaveProperty('entry-49');
    });

    it('notifies subscribers once for the same burst', () => {
        let notifications = 0;
        const unsubscribe = BreachStatusStore.subscribe(() => { notifications++; });

        for (let i = 0; i < 50; i++) {
            BreachStatusStore.setEntryStatus('/db.kdbx', `entry-${i}`, status);
        }
        expect(notifications).toBe(0);

        vi.advanceTimersByTime(250);
        expect(notifications).toBe(1);
        unsubscribe();
    });

    it('reads back a status before it has been persisted', () => {
        BreachStatusStore.setEntryStatus('/db.kdbx', 'entry-1', { ...status, isPwned: true, count: 9 });
        expect(writes.set).toBe(0);

        const read = BreachStatusStore.getEntryStatus('/db.kdbx', 'entry-1');
        expect(read?.isPwned).toBe(true);
        expect(read?.count).toBe(9);
    });

    it('bumps the version only when the coalesced write lands', () => {
        const before = BreachStatusStore.getVersion();
        BreachStatusStore.setEntryStatus('/db.kdbx', 'entry-1', status);
        expect(BreachStatusStore.getVersion()).toBe(before);

        vi.advanceTimersByTime(250);
        expect(BreachStatusStore.getVersion()).toBe(before + 1);
    });

    it('flushes a pending write on demand and does nothing when there is none', () => {
        BreachStatusStore.setEntryStatus('/db.kdbx', 'entry-1', status);
        BreachStatusStore.flush();
        expect(writes.set).toBe(1);

        BreachStatusStore.flush();
        expect(writes.set).toBe(1);

        // the timer must not fire a second write for the same batch
        vi.advanceTimersByTime(250);
        expect(writes.set).toBe(1);
    });

    it('writes clears through immediately', () => {
        BreachStatusStore.setEntryStatus('/db.kdbx', 'entry-1', status);
        vi.advanceTimersByTime(250);
        writes.set = 0;

        BreachStatusStore.clearStatus('/db.kdbx', 'entry-1');
        expect(writes.set).toBe(1);
        expect(BreachStatusStore.getEntryStatus('/db.kdbx', 'entry-1')).toBeNull();
    });

    it('drops a pending write when the cache is cleared wholesale', () => {
        BreachStatusStore.setEntryStatus('/db.kdbx', 'entry-1', status);
        BreachStatusStore.clearAll();
        expect(writes.remove).toBe(1);

        vi.advanceTimersByTime(250);
        expect(writes.set).toBe(0);
        expect(BreachStatusStore.getEntryStatus('/db.kdbx', 'entry-1')).toBeNull();
    });
});

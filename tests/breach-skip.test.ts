import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
};

const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');

const entryWith = (password: string | kdbxweb.ProtectedValue | undefined) => ({
    id: 'entry-1',
    title: 'Passkey entry',
    username: 'bob',
    password,
} as any);

describe('breach check on passwordless entries', () => {
    it('skips checking and stores a clean status for an empty password', async () => {
        // would throw on any network call in this environment; resolving at
        // all proves HIBP was never contacted
        const result = await BreachCheckService.checkEntry('/db.kdbx', entryWith(''));
        expect(result).toBe(false);
        const status = BreachStatusStore.getEntryStatus('/db.kdbx', 'entry-1');
        expect(status?.isPwned).toBe(false);
        expect(status?.strength).toBeNull();
    });

    it('treats an empty protected value and a missing password the same', async () => {
        expect(await BreachCheckService.checkEntry('/db.kdbx', entryWith(kdbxweb.ProtectedValue.fromString('')))).toBe(false);
        expect(await BreachCheckService.checkEntry('/db.kdbx', entryWith(undefined))).toBe(false);
    });

    it('clears a stale flagged status on recheck', async () => {
        BreachStatusStore.setEntryStatus('/db.kdbx', 'entry-1', {
            isPwned: true, count: 7,
            strength: { score: 0, feedback: { warning: '', suggestions: [] } },
        });
        await BreachCheckService.checkEntry('/db.kdbx', entryWith(''));
        const status = BreachStatusStore.getEntryStatus('/db.kdbx', 'entry-1');
        expect(status?.isPwned).toBe(false);
        expect(status?.strength).toBeNull();
    });
});

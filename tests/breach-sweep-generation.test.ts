import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Entry, Group } from '../src/types/database';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

// A sweep parks on in-flight HIBP fetches. Cancellation used to be a boolean
// that the next unlock's sweep cleared, so a lock followed quickly by an
// unlock (a fingerprint away) released the parked lanes back into the vault
// that had just closed: they went on sending its passwords, and wrote its
// verdicts through BreachStatusStore, which reads and writes under whatever
// key BreachCacheCrypto currently holds. The closed vault's entries ended up
// inside the newly opened vault's cache blob.

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

const strong = { score: 4, feedback: { warning: '', suggestions: [] } };

const entry = (id: string): Entry => ({
    id, title: id, username: `${id}@example.com`, password: `pw-${id}`,
    created: new Date(0), modified: new Date(0), attachments: [], history: [],
    expires: false, customFields: [],
});
const vault = (ids: string[]): Group => ({ id: 'root', name: 'All Entries', groups: [], entries: ids.map(entry) });

// Every password of the closing vault parks, so all four lanes are mid-fetch
// when the lock lands, which is the state four real lookups leave them in
const parkedSweep = () => {
    const checked: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    let parked = 0;
    vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockImplementation(async (pw: string) => {
        checked.push(pw);
        if (pw.startsWith('pw-a')) { parked++; await gate; }
        return { isPwned: true, pwnedCount: 42, strength: strong };
    });
    return { checked, open: () => open(), lanesParked: async () => { while (parked < 4) await new Promise(r => setTimeout(r, 5)); } };
};

describe('a sweep whose vault is locked mid-flight', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        for (const key of Object.keys(localStorage as object)) localStorage.removeItem(key);
    });

    it('does not resume when the next unlock starts its own sweep', async () => {
        const rig = parkedSweep();
        const sweepA = BreachCheckService.checkGroup('/A.kdbx', vault(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']));
        await rig.lanesParked();

        BreachCheckService.cancelChecks();
        const afterLock = rig.checked.length;
        const sweepB = BreachCheckService.checkGroup('/B.kdbx', vault(['b1', 'b2']));
        rig.open();
        await Promise.all([sweepA, sweepB]);

        expect(rig.checked.slice(afterLock).filter(p => p.startsWith('pw-a'))).toEqual([]);
    });

    it('keeps the closed vault out of the newly opened vault cache', async () => {
        const dbA = kdbxweb.Kdbx.create(cred('a'), 'A');
        const dbB = kdbxweb.Kdbx.create(cred('b'), 'B');
        const rig = parkedSweep();

        BreachCacheCrypto.unlock(dbA);
        const sweepA = BreachCheckService.checkGroup('/A.kdbx', vault(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']));
        await rig.lanesParked();

        BreachCheckService.cancelChecks();
        BreachCacheCrypto.lock();
        BreachCacheCrypto.unlock(dbB);
        const sweepB = BreachCheckService.checkGroup('/B.kdbx', vault(['b1', 'b2']));
        rig.open();
        await Promise.all([sweepA, sweepB]);
        BreachStatusStore.flush();

        const blob = BreachCacheCrypto.read<Record<string, Record<string, unknown>>>('breach') ?? {};
        expect(Object.keys(blob)).not.toContain('/A.kdbx');
        // The vault that is actually open still gets its own results
        expect(Object.keys(blob['/B.kdbx'] ?? {})).toEqual(['b1', 'b2']);
    });

    it('leaves the running sweep progress alone when a stale one unwinds', async () => {
        const rig = parkedSweep();
        const sweepA = BreachCheckService.checkGroup('/A.kdbx', vault(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']));
        await rig.lanesParked();

        BreachCheckService.cancelChecks();
        const sweepB = BreachCheckService.checkGroup('/B.kdbx', vault(['b1', 'b2']));
        rig.open();
        await Promise.all([sweepA, sweepB]);

        // The stale sweep must not have counted its entries into this one
        const { passwords } = BreachCheckService.getProgress();
        expect(passwords.checked).toBeLessThanOrEqual(passwords.total);
    });
});

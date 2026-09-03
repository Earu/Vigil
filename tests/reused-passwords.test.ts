import { describe, it, expect, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { Entry, Group } from '../src/types/database';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
};

const { BreachCheckService } = await import('../src/services/BreachCheckService');

const entry = (id: string, title: string, password: string | kdbxweb.ProtectedValue): Entry => ({
    id,
    title,
    username: `${id}@example.com`,
    password,
    created: new Date(0),
    modified: new Date(0),
    attachments: [],
    history: [],
    expires: false,
    customFields: [],
});

const group = (id: string, name: string, entries: Entry[], groups: Group[] = []): Group =>
    ({ id, name, entries, groups });

describe('reused password detection', () => {
    it('groups the entries that share a password and leaves unique ones out', () => {
        const root = group('root', 'All Entries', [
            entry('a', 'Alpha', 'shared-pw'),
            entry('b', 'Bravo', 'shared-pw'),
            entry('c', 'Charlie', 'its-own-pw'),
        ]);

        const clusters = BreachCheckService.findReusedPasswords(root);
        expect(clusters).toHaveLength(1);
        expect(clusters[0].count).toBe(2);
        expect(clusters[0].entries.map(e => e.entry.id).sort()).toEqual(['a', 'b']);
    });

    it('matches across groups and reports where each entry lives', () => {
        const child = group('sub', 'Work', [entry('b', 'Bravo', 'shared-pw')]);
        const root = group('root', 'All Entries', [entry('a', 'Alpha', 'shared-pw')], [child]);

        const [cluster] = BreachCheckService.findReusedPasswords(root);
        expect(cluster.count).toBe(2);
        const byId = new Map(cluster.entries.map(e => [e.entry.id, e.group.name]));
        expect(byId.get('a')).toBe('All Entries');
        expect(byId.get('b')).toBe('Work');
    });

    it('treats a protected value and a plain string with the same text as one password', () => {
        const root = group('root', 'All Entries', [
            entry('a', 'Alpha', 'shared-pw'),
            entry('b', 'Bravo', kdbxweb.ProtectedValue.fromString('shared-pw')),
        ]);

        expect(BreachCheckService.findReusedPasswords(root)[0].count).toBe(2);
    });

    it('ignores passwordless entries, which would otherwise all look identical', () => {
        const root = group('root', 'All Entries', [
            entry('a', 'Passkey only', ''),
            entry('b', 'Also passkey only', kdbxweb.ProtectedValue.fromString('')),
            entry('c', 'No password either', ''),
        ]);

        expect(BreachCheckService.findReusedPasswords(root)).toEqual([]);
    });

    it('skips the recycle bin so deleted entries do not flag live ones', () => {
        const bin: Group = { ...group('bin', 'Recycle Bin', [entry('old', 'Deleted', 'shared-pw')]), isRecycleBin: true };
        const root = group('root', 'All Entries', [entry('a', 'Alpha', 'shared-pw')], [bin]);

        expect(BreachCheckService.findReusedPasswords(root)).toEqual([]);
    });

    it('orders the widest reuse first', () => {
        const root = group('root', 'All Entries', [
            entry('a', 'Alpha', 'pair'),
            entry('b', 'Bravo', 'pair'),
            entry('c', 'Charlie', 'trio'),
            entry('d', 'Delta', 'trio'),
            entry('e', 'Echo', 'trio'),
        ]);

        expect(BreachCheckService.findReusedPasswords(root).map(c => c.count)).toEqual([3, 2]);
    });
});

// The detector hashes each password once per model object and buckets by
// hash; plaintext is only decrypted again to confirm a bucket with more than
// one member. These tests pin the decrypt counts and the collision handling
describe('reused password decrypt cache', () => {
    it('does not re-decrypt unique entries when the same models are asked again', () => {
        const pv1 = kdbxweb.ProtectedValue.fromString('unique-one');
        const pv2 = kdbxweb.ProtectedValue.fromString('unique-two');
        const spy1 = vi.spyOn(pv1, 'getText');
        const spy2 = vi.spyOn(pv2, 'getText');
        const root = group('root', 'All Entries', [
            entry('a', 'Alpha', pv1),
            entry('b', 'Bravo', pv2),
        ]);

        expect(BreachCheckService.findReusedPasswords(root)).toEqual([]);
        expect(spy1).toHaveBeenCalledTimes(1);
        expect(spy2).toHaveBeenCalledTimes(1);

        // Second call over the same model objects: hashes come from the
        // cache, and singleton buckets never reach the confirm step
        expect(BreachCheckService.findReusedPasswords(root)).toEqual([]);
        expect(spy1).toHaveBeenCalledTimes(1);
        expect(spy2).toHaveBeenCalledTimes(1);
    });

    it('decrypts a shared pair only to confirm the cluster, never to re-hash', () => {
        const pv1 = kdbxweb.ProtectedValue.fromString('shared-pw');
        const pv2 = kdbxweb.ProtectedValue.fromString('shared-pw');
        const spy1 = vi.spyOn(pv1, 'getText');
        const root = group('root', 'All Entries', [
            entry('a', 'Alpha', pv1),
            entry('b', 'Bravo', pv2),
        ]);

        // First call: one decrypt for the hash, one to confirm the cluster
        expect(BreachCheckService.findReusedPasswords(root)).toHaveLength(1);
        expect(spy1).toHaveBeenCalledTimes(2);

        // Second call: the hash is cached, only the confirm decrypt remains
        expect(BreachCheckService.findReusedPasswords(root)).toHaveLength(1);
        expect(spy1).toHaveBeenCalledTimes(3);
    });

    it('never reports a hash collision as reuse and only decrypts clustered candidates', () => {
        const svc = BreachCheckService as any;
        const original = svc.cyrb53;
        // Force collisions: every password hashing to its first character
        svc.cyrb53 = (text: string) => text[0];
        try {
            const pvLone = kdbxweb.ProtectedValue.fromString('zz-unique');
            const spyLone = vi.spyOn(pvLone, 'getText');
            const root = group('root', 'All Entries', [
                entry('a', 'Alpha', 'xx-shared'),
                entry('b', 'Bravo', 'xx-shared'),
                entry('c', 'Charlie', 'xy-collides'),
                entry('d', 'Delta', pvLone),
            ]);

            // a, b and c share the bucket 'x'; only a and b truly match
            const clusters = BreachCheckService.findReusedPasswords(root);
            expect(clusters).toHaveLength(1);
            expect(clusters[0].count).toBe(2);
            expect(clusters[0].entries.map(e => e.entry.id).sort()).toEqual(['a', 'b']);

            // d sits alone in bucket 'z': hashed once, never confirm-decrypted
            expect(spyLone).toHaveBeenCalledTimes(1);
        } finally {
            svc.cyrb53 = original;
        }
    });
});

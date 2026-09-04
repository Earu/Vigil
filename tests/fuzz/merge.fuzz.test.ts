import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, tick } from '../helpers';
import { settings } from './fuzz';

// Two replicas of one vault edit, delete and create entries independently,
// then this side saves and merges the other side's file. The rules the
// merge is meant to follow are written out as invariants and checked over
// random operation mixes, so a data-loss regression shows up as a shrunk
// counterexample instead of a bug report months later.
//
// The rules (KeePass semantics, see reconcileTombstones):
//   an entry deleted on one side and untouched on the other is gone
//   an entry edited after the other side deleted it survives with the edit
//   an entry edited on both sides keeps the newer edit
//   anything created on either side is present
//   no uuid ever appears twice

const env = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../../src/services/KeepassDatabaseService');

const WEEK = 7 * 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

type RemoteOp = { kind: 'edit' | 'delete'; index: number; minutesAgo: number } | { kind: 'create'; title: string };
type LocalOp = { kind: 'edit' | 'delete'; index: number } | { kind: 'create'; title: string };

const index = fc.integer({ min: 0, max: 3 });
const title = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
const remoteOp: fc.Arbitrary<RemoteOp> = fc.oneof(
    fc.record({ kind: fc.constantFrom('edit', 'delete') as fc.Arbitrary<'edit' | 'delete'>, index, minutesAgo: fc.integer({ min: 1, max: 600 }) }),
    fc.record({ kind: fc.constant('create' as const), title }),
);
const localOp: fc.Arbitrary<LocalOp> = fc.oneof(
    fc.record({ kind: fc.constantFrom('edit', 'delete') as fc.Arbitrary<'edit' | 'delete'>, index }),
    fc.record({ kind: fc.constant('create' as const), title }),
);

const COUNT = 4;
const baseTitle = (i: number) => `E${i}`;

async function establishedVault(): Promise<{ db: kdbxweb.Kdbx; ids: string[] }> {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const group = db.createGroup(db.getDefaultGroup(), 'Work');
    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
        const entry = db.createEntry(i % 2 === 0 ? group : db.getDefaultGroup());
        entry.fields.set('Title', baseTitle(i));
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(`pw${i}`));
        ids.push(entry.uuid.id);
    }
    const old = new Date(Date.now() - WEEK);
    for (const item of db.getDefaultGroup().allGroupsAndEntries()) {
        item.times.lastModTime = old;
        item.times.locationChanged = old;
    }
    env.disk.bytes = Buffer.from(await db.save());
    env.disk.mtime = 100;
    return { db: await loadSaved(env), ids };
}

const byId = (db: kdbxweb.Kdbx, id: string) => [...db.getDefaultGroup().allEntries()].find(e => e.uuid.id === id);
const titleOf = (e: kdbxweb.KdbxEntry) => Svc.getFieldString(e.fields.get('Title') as string | kdbxweb.ProtectedValue);

describe('merge under fuzz', () => {
    it('holds the merge rules over any mix of edits, deletes and creates on two replicas', async () => {
        await fc.assert(fc.asyncProperty(fc.array(remoteOp, { maxLength: 4 }), fc.array(localOp, { maxLength: 4 }), async (remoteOps, localOps) => {
            const { db: local, ids } = await establishedVault();
            Svc.setPath('/fake.kdbx', new Uint8Array(env.disk.bytes!));
            await tick();

            // The other machine: every op is applied to a fresh load of the
            // file and written back with an explicit past timestamp
            const remoteEdited = new Map<string, { title: string; at: number }>();
            const remoteDeleted = new Map<string, number>();
            const remoteCreated: string[] = [];
            const remote = await loadSaved(env);
            for (const op of remoteOps) {
                if (op.kind === 'create') {
                    const entry = remote.createEntry(remote.getDefaultGroup());
                    entry.fields.set('Title', `R-${op.title}`);
                    entry.times.lastModTime = new Date(Date.now() - MINUTE);
                    remoteCreated.push(entry.uuid.id);
                    continue;
                }
                const id = ids[op.index];
                const entry = byId(remote, id);
                if (!entry) continue;
                const at = Date.now() - op.minutesAgo * MINUTE;
                if (op.kind === 'edit') {
                    entry.fields.set('Title', `R${op.index}-${op.minutesAgo}`);
                    entry.times.lastModTime = new Date(at);
                    remoteEdited.set(id, { title: `R${op.index}-${op.minutesAgo}`, at });
                } else {
                    entry.parentGroup!.entries = entry.parentGroup!.entries.filter(e => e !== entry);
                    const tomb = new kdbxweb.KdbxDeletedObject();
                    tomb.uuid = entry.uuid;
                    tomb.deletionTime = new Date(at);
                    remote.deletedObjects.push(tomb);
                    remoteDeleted.set(id, at);
                    remoteEdited.delete(id);
                }
            }
            env.disk.bytes = Buffer.from(await remote.save());
            env.disk.mtime += 50;

            // This side: the same kinds of change through the UI model, all
            // of them "now", then one save that finds the file changed
            let model = Svc.convertKdbxToDatabase(local);
            const localEdited = new Map<string, string>();
            const localDeleted = new Set<string>();
            const localCreated: string[] = [];
            const findModel = (id: string) => Svc.findEntry(id, model.root);
            for (const op of localOps) {
                if (op.kind === 'create') {
                    const fresh = Svc.prepareEntryForSave({ ...Svc.createNewEntry(), title: `L-${op.title}` });
                    const [next, saved] = Svc.saveEntry(model, fresh, model.root, true);
                    model = next;
                    localCreated.push(saved.id);
                    continue;
                }
                const id = ids[op.index];
                const [entry, group] = findModel(id);
                if (!entry || !group) continue;
                if (op.kind === 'edit') {
                    const edited = Svc.prepareEntryForSave({ ...entry, title: `L${op.index}` });
                    [model] = Svc.saveEntry(model, edited, group, false);
                    localEdited.set(id, `L${op.index}`);
                    localDeleted.delete(id);
                } else {
                    model = Svc.removeEntry(model, entry);
                    const [binned] = Svc.findEntry(id, model.root);
                    if (binned) model = Svc.removeEntry(model, binned);
                    localDeleted.add(id);
                    localEdited.delete(id);
                }
            }
            await Svc.saveDatabase(model, local);
            const merged = await loadSaved(env);
            const entries = [...merged.getDefaultGroup().allEntries()];

            const seen = new Set<string>();
            for (const entry of entries) {
                expect(seen.has(entry.uuid.id), `duplicate ${titleOf(entry)}`).toBe(false);
                seen.add(entry.uuid.id);
            }

            for (const id of [...remoteCreated, ...localCreated]) {
                expect(seen.has(id), 'a created entry is missing').toBe(true);
            }

            for (let i = 0; i < COUNT; i++) {
                const id = ids[i];
                const present = byId(merged, id);
                const tag = `E${i} remote=${JSON.stringify(remoteEdited.get(id) ?? (remoteDeleted.has(id) ? 'deleted' : 'untouched'))} local=${localEdited.get(id) ?? (localDeleted.has(id) ? 'deleted' : 'untouched')}`;
                if (localDeleted.has(id)) {
                    // A local deletion is the newest event: nothing remote
                    // predates it by less than a minute
                    expect(present, `${tag}: survived a local delete`).toBeUndefined();
                } else if (remoteDeleted.has(id)) {
                    if (localEdited.has(id)) {
                        expect(present, `${tag}: a later local edit lost to an older remote delete`).toBeDefined();
                        expect(titleOf(present!)).toBe(localEdited.get(id));
                    } else {
                        expect(present, `${tag}: survived a remote delete`).toBeUndefined();
                    }
                } else {
                    expect(present, `${tag}: an entry nobody deleted is gone`).toBeDefined();
                    const expectedTitle = localEdited.get(id) ?? remoteEdited.get(id)?.title ?? baseTitle(i);
                    expect(titleOf(present!), tag).toBe(expectedTitle);
                }
            }
        }), settings({ numRuns: Math.min(settings().numRuns!, 60) }));
    }, 120_000);
});

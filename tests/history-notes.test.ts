import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { cred } from './helpers';
import { HistoryNotesService, HistoryNotes } from '../src/services/HistoryNotesService';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2025, 0, 1);

// A vault holding one entry with revisions at the given ages, in days.
// Oldest first, the order kdbx keeps history in and the end retention trims
function vaultWithRevisions(ages: number[]): { db: kdbxweb.Kdbx; entry: kdbxweb.KdbxEntry } {
    const db = kdbxweb.Kdbx.create(cred(), 'Vault');
    db.setVersion(3);
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', 'Site');
    for (const age of [...ages].sort((a, b) => b - a)) {
        const revision = new kdbxweb.KdbxEntry();
        revision.copyFrom(entry);
        revision.times.lastModTime = new Date(NOW - age * DAY);
        entry.history.push(revision);
    }
    return { db, entry };
}

// What kdbxweb's pushHistory would have left behind for those revisions
function markAllRecorded(entry: kdbxweb.KdbxEntry): void {
    entry._editState = {
        added: entry.history.map(h => h.times.lastModTime!.getTime()),
        deleted: [],
    };
}

const notesOf = (pairs: Array<[string, number[]]>): HistoryNotes =>
    new Map(pairs.map(([uuid, times]) => [uuid, new Set(times)]));

describe('encoding history notes', () => {
    it('round trips', () => {
        const notes = notesOf([['abc+/dEF==', [1735689600, 1735689700]], ['xyz==', [1700000000]]]);
        const decoded = HistoryNotesService.decode(HistoryNotesService.encode(notes));

        expect([...decoded.get('abc+/dEF==')!].sort()).toEqual([1735689600, 1735689700]);
        expect([...decoded.get('xyz==')!]).toEqual([1700000000]);
    });

    it('reads a value it does not recognise as absent rather than guessing', () => {
        expect(HistoryNotesService.decode('9;abc==:1,2').size).toBe(0);
        expect(HistoryNotesService.decode('nonsense').size).toBe(0);
        expect(HistoryNotesService.decode(undefined).size).toBe(0);
    });

    it('encodes nothing as an empty string, which write turns into no key', () => {
        expect(HistoryNotesService.encode(new Map())).toBe('');
        // A uuid with no times cannot say anything and must not occupy space
        expect(HistoryNotesService.encode(notesOf([['abc==', []]]))).toBe('');
    });

    it('stays under the size ceiling, dropping the oldest first', () => {
        // Far more than the ceiling holds: 20k entries at ~40 bytes each
        const many: Array<[string, number[]]> = [];
        for (let i = 0; i < 20000; i++) {
            many.push([`uuid${String(i).padStart(19, '0')}==`, [1700000000 + i]]);
        }
        const encoded = HistoryNotesService.encode(notesOf(many));

        expect(encoded.length).toBeLessThanOrEqual(256 * 1024);
        const kept = HistoryNotesService.decode(encoded);
        expect(kept.size).toBeGreaterThan(0);
        // The newest survived; the oldest is what fell off
        expect(kept.has('uuid0000000000000019999==')).toBe(true);
        expect(kept.has('uuid0000000000000000000==')).toBe(false);
    });
});

describe('collecting what this replica should record', () => {
    it('leaves out revisions old enough to have reached everyone', () => {
        const { db, entry } = vaultWithRevisions([1, 10, 200]);
        markAllRecorded(entry);

        const times = HistoryNotesService.collect(db, NOW).get(entry.uuid.id)!;

        expect(times.size).toBe(2);
        expect(times.has(Math.floor((NOW - 200 * DAY) / 1000))).toBe(false);
    });

    it('leaves out revisions retention has already dropped', () => {
        const { db, entry } = vaultWithRevisions([1, 2]);
        markAllRecorded(entry);
        // Retention trims the older revision, but its note is still in hand
        entry.history.shift();

        const times = HistoryNotesService.collect(db, NOW).get(entry.uuid.id)!;

        expect(times.size).toBe(1);
        expect(times.has(Math.floor((NOW - 1 * DAY) / 1000))).toBe(true);
    });

    it('records nothing for an entry this replica never archived', () => {
        const { db } = vaultWithRevisions([1, 2]);
        // No _editState: these revisions arrived from somewhere else
        expect(HistoryNotesService.collect(db, NOW).size).toBe(0);
    });
});

describe('the notes a vault carries', () => {
    it('unions what every replica recorded', () => {
        const { db, entry } = vaultWithRevisions([]);
        db.meta.customData.set(HistoryNotesService.keyFor('aaaa'),
            { value: HistoryNotesService.encode(notesOf([[entry.uuid.id, [100]]])) });
        db.meta.customData.set(HistoryNotesService.keyFor('bbbb'),
            { value: HistoryNotesService.encode(notesOf([[entry.uuid.id, [200]]])) });

        expect([...HistoryNotesService.read(db).get(entry.uuid.id)!].sort()).toEqual([100, 200]);
    });

    it('writes only this replica key and carries the others untouched', () => {
        const { db, entry } = vaultWithRevisions([1]);
        markAllRecorded(entry);
        const theirs = HistoryNotesService.encode(notesOf([['other==', [500]]]));
        db.meta.customData.set(HistoryNotesService.keyFor('them'), { value: theirs });

        HistoryNotesService.write(db, 'us', NOW);

        expect(db.meta.customData.get(HistoryNotesService.keyFor('them'))?.value).toBe(theirs);
        expect(db.meta.customData.get(HistoryNotesService.keyFor('us'))?.value).toBeTruthy();
    });

    it('removes this replica key when there is nothing left to record', () => {
        const { db, entry } = vaultWithRevisions([1]);
        markAllRecorded(entry);
        HistoryNotesService.write(db, 'us', NOW);
        expect(db.meta.customData.has(HistoryNotesService.keyFor('us'))).toBe(true);

        // Everything ages out
        HistoryNotesService.write(db, 'us', NOW + 365 * DAY);

        // Not an entry with an empty value: kdbxweb drops those on write, so
        // the key would linger in memory holding nothing
        expect(db.meta.customData.has(HistoryNotesService.keyFor('us'))).toBe(false);
    });

    it('drops keys whose notes have all aged out', () => {
        const { db } = vaultWithRevisions([]);
        db.meta.customData.set(HistoryNotesService.keyFor('stale'), { value: '' });
        db.meta.customData.set('KPXC_BROWSER_firefox', { value: 'not ours' });

        HistoryNotesService.purgeEmpty(db);

        expect(db.meta.customData.has(HistoryNotesService.keyFor('stale'))).toBe(false);
        expect(db.meta.customData.get('KPXC_BROWSER_firefox')?.value).toBe('not ours');
    });

    it('leaves notes it cannot read where they are', () => {
        const { db } = vaultWithRevisions([]);
        // A later Vigil writing notes some other way. This build reads it as
        // empty because it cannot parse it, which is not a reason to delete it
        db.meta.customData.set(HistoryNotesService.keyFor('newer'), { value: '9;something-else' });

        HistoryNotesService.purgeEmpty(db);

        expect(db.meta.customData.get(HistoryNotesService.keyFor('newer'))?.value).toBe('9;something-else');
    });
});

describe('handing the notes to the merge', () => {
    it('marks only revisions the entry still holds', () => {
        const { db, entry } = vaultWithRevisions([1, 2]);
        const held = entry.history.map(h => Math.floor(h.times.lastModTime!.getTime() / 1000));

        HistoryNotesService.apply(db, notesOf([[entry.uuid.id, [...held, 999]]]));

        // The note for a revision this entry does not have is inert, and
        // carrying it would only cost the merge a longer list to scan
        expect(entry._editState!.added.sort()).toEqual(
            entry.history.map(h => h.times.lastModTime!.getTime()).sort()
        );
    });

    it('adds to what this session recorded rather than replacing it', () => {
        const { db, entry } = vaultWithRevisions([1, 2]);
        const [older, newer] = entry.history;
        // This session archived one of them; the file knows about the other
        entry._editState = { added: [newer.times.lastModTime!.getTime()], deleted: [] };

        HistoryNotesService.apply(db, notesOf([
            [entry.uuid.id, [Math.floor(older.times.lastModTime!.getTime() / 1000)]],
        ]));

        expect(entry._editState!.added.sort()).toEqual(
            [older, newer].map(h => h.times.lastModTime!.getTime()).sort()
        );
    });

    it('never records a deletion', () => {
        const { db, entry } = vaultWithRevisions([1]);
        HistoryNotesService.apply(db, notesOf([
            [entry.uuid.id, [Math.floor(entry.history[0].times.lastModTime!.getTime() / 1000)]],
        ]));

        // History is the union of what replicas recorded; nothing here can
        // suppress a revision another replica still holds
        expect(entry._editState!.deleted).toEqual([]);
    });
});

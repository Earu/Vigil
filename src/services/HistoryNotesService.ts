import * as kdbxweb from 'kdbxweb';

// Entry history that survives a synced folder.
//
// A merge decides entry history from notes saying which revisions a replica
// recorded. The kdbx format has nowhere to write those down, so kdbxweb keeps
// them in memory, and kdbxweb's own guidance is to drop them once the state
// has been written out. Both of those assume one central upstream that every
// replica reads before it writes. A kdbx file in a synced folder is not that:
// a machine that has been offline writes whatever base it holds straight over
// the top, and nothing made it read first.
//
// Against that, notes held only in memory run out exactly when they are
// needed. They are gone after a lock or a restart, and they never existed on
// the machine doing the overwriting, so a revision one replica recorded looks
// to another like a revision somebody deleted, and the merge drops it.
//
// So the notes go in the file, under a key per replica in meta.customData.
// kdbxweb's customData merge takes any key the local side is missing, so
// distinct keys union rather than overwrite one another and every replica
// ends up holding what the others recorded. Keys Vigil does not recognise are
// carried through untouched, by KeePassXC as well, which is what lets this
// travel with the vault instead of being an index kept somewhere alongside it.
//
// Only additions are recorded. Nothing here says a revision was deleted, so a
// merge never suppresses one: history is the union of what every replica
// recorded, and retention is the single thing that decides what is kept. That
// converges on its own, without the phantom deletions the remove-win scheme
// produces once replicas write out of order, which in a synced folder they do.

const KEY_PREFIX = 'VIGIL_HISTORY_';

// Format marker. A reader that does not recognise it treats the value as
// absent rather than guessing, so an older Vigil meeting a newer note loses
// the benefit of it instead of misreading it
const FORMAT = '1';

// Revisions this old have reached every replica that is ever coming back, and
// a replica offline longer than this has already lost the race by other means.
// This is what keeps the notes from growing for the life of the vault: without
// it every revision retention holds on to would be carried for ever
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// A hard ceiling on what this can add to the file, for the vault where a great
// many entries were all edited recently. Encoding runs newest revision first,
// so what falls off the end is the oldest and least likely to be contested
const MAX_ENCODED_BYTES = 256 * 1024;

// Entry uuid -> revision times, in whole seconds. Seconds rather than
// milliseconds because kdbx stores times to the second: a note written at
// finer resolution than the revision it names could never match one
export type HistoryNotes = Map<string, Set<number>>;

export class HistoryNotesService {
    static isNotesKey(key: string): boolean {
        return key.startsWith(KEY_PREFIX);
    }

    static keyFor(replicaId: string): string {
        return KEY_PREFIX + replicaId;
    }

    // This goes in the user's vault, so it is written tight rather than
    // readably: base36 throughout, and every time after the first as the gap
    // from the one before. Revisions of an entry cluster in time, so those
    // gaps are far shorter than the timestamps would be, which takes about a
    // third off a vault carrying several revisions per entry.
    //
    // Separators come from outside the base64 alphabet, since the uuids are in
    // it. The leading marker is the format: a reader that does not know it
    // treats the whole value as absent rather than guessing at it
    static encode(notes: HistoryNotes): string {
        const entries = [...notes]
            .map(([uuid, times]) => ({ uuid, times: [...times].sort((a, b) => a - b) }))
            .filter(entry => entry.times.length > 0)
            // Newest first, so the cap below drops the oldest
            .sort((a, b) => b.times[b.times.length - 1] - a.times[a.times.length - 1]);

        const parts: string[] = [];
        let length = FORMAT.length;
        for (const entry of entries) {
            const times = entry.times.map((time, index) =>
                (index === 0 ? time : time - entry.times[index - 1]).toString(36));
            const part = `${entry.uuid}:${times.join(',')}`;
            if (length + 1 + part.length > MAX_ENCODED_BYTES) break;
            parts.push(part);
            length += 1 + part.length;
        }

        return parts.length > 0 ? `${FORMAT};${parts.join(';')}` : '';
    }

    static decode(value: string | undefined): HistoryNotes {
        const notes: HistoryNotes = new Map();
        if (!value) return notes;

        const parts = value.split(';');
        if (parts.shift() !== FORMAT) return notes;

        for (const part of parts) {
            const separator = part.lastIndexOf(':');
            if (separator <= 0) continue;

            const times = new Set<number>();
            let running = 0;
            for (const [index, token] of part.slice(separator + 1).split(',').entries()) {
                const number = parseInt(token, 36);
                if (!Number.isFinite(number)) break;
                running = index === 0 ? number : running + number;
                times.add(running);
            }
            if (times.size > 0) notes.set(part.slice(0, separator), times);
        }
        return notes;
    }

    private static union(into: HistoryNotes, from: HistoryNotes): void {
        for (const [uuid, times] of from) {
            const existing = into.get(uuid);
            if (existing) {
                for (const time of times) existing.add(time);
            } else {
                into.set(uuid, new Set(times));
            }
        }
    }

    // Every replica's notes held in this database, merged into one set
    static read(kdbxDb: kdbxweb.Kdbx): HistoryNotes {
        const notes: HistoryNotes = new Map();
        for (const [key, item] of kdbxDb.meta.customData) {
            if (this.isNotesKey(key)) {
                this.union(notes, this.decode(item?.value));
            }
        }
        return notes;
    }

    // Hand the notes to kdbxweb as the tombstones its merge reads. A note only
    // means something for a revision this entry still holds, so anything else
    // is dropped rather than carried; the merge never asks about the rest.
    //
    // Unions with whatever is already there: entries edited in this session
    // hold notes of their own that have not been written out yet, and an
    // incoming file must add to those rather than replace them
    static apply(kdbxDb: kdbxweb.Kdbx, ...sources: HistoryNotes[]): void {
        const notes: HistoryNotes = new Map();
        for (const source of sources) this.union(notes, source);

        for (const entry of kdbxDb.getDefaultGroup().allEntries()) {
            const known = notes.get(entry.uuid.id);
            const added = new Set(entry._editState?.added ?? []);
            for (const revision of entry.history) {
                const time = revision.times.lastModTime?.getTime();
                if (time === undefined) continue;
                if (known?.has(Math.floor(time / 1000))) added.add(time);
            }
            entry._editState = added.size > 0
                ? { added: [...added], deleted: [] }
                : undefined;
        }
    }

    // What this replica should write out: every revision it holds a note for
    // that is still in the entry's history and recent enough to be contested
    static collect(kdbxDb: kdbxweb.Kdbx, now = Date.now()): HistoryNotes {
        const notes: HistoryNotes = new Map();
        const oldest = now - MAX_AGE_MS;

        for (const entry of kdbxDb.getDefaultGroup().allEntries()) {
            const added = entry._editState?.added;
            if (!added?.length) continue;

            const known = new Set(added);
            const times = new Set<number>();
            for (const revision of entry.history) {
                const time = revision.times.lastModTime?.getTime();
                if (time === undefined || time < oldest) continue;
                if (known.has(time)) times.add(Math.floor(time / 1000));
            }
            if (times.size > 0) notes.set(entry.uuid.id, times);
        }
        return notes;
    }

    // Writes this replica's notes into the database about to be saved. Only
    // this replica's own key is touched; the others are what the merge brought
    // in and are carried on unread, which is how a note reaches a replica that
    // never met the one that wrote it.
    //
    // customData timestamps are a 4.1 field. Below that the entry is still
    // written and still reaches a replica that has none, but a replica holding
    // an older copy of this key has no date to compare and keeps what it has,
    // so updates stop propagating. Notes that fail to arrive cost only the
    // improvement they would have made, which is why this does not refuse to
    // run on an older file
    static write(kdbxDb: kdbxweb.Kdbx, replicaId: string, now = Date.now()): void {
        const value = this.encode(this.collect(kdbxDb, now));
        const key = this.keyFor(replicaId);

        // An item with no value is dropped on write, so an empty note set has
        // to delete the key rather than store nothing under it
        if (value) {
            kdbxDb.meta.customData.set(key, { value, lastModified: new Date(now) });
        } else {
            kdbxDb.meta.customData.delete(key);
        }
    }

    // Drops note keys whose contents have all aged out. A replica that still
    // holds the key puts it back on the next merge, which is harmless: the
    // value it carries is age bounded either way, so this is about keeping
    // dead keys from accumulating rather than about deleting anything for good.
    //
    // A value in a format this build does not know is left alone. It reads as
    // empty here only because it cannot be parsed, and a newer Vigil writing
    // notes another way is the likeliest reason for that: deleting it would
    // have each version stripping the other's notes on alternate saves
    static purgeEmpty(kdbxDb: kdbxweb.Kdbx): void {
        for (const [key, item] of [...kdbxDb.meta.customData]) {
            if (!this.isNotesKey(key)) continue;
            const value = item?.value;
            const ours = !value || value.startsWith(`${FORMAT};`);
            if (ours && this.decode(value).size === 0) {
                kdbxDb.meta.customData.delete(key);
            }
        }
    }
}

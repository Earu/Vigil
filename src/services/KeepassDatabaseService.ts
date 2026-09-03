import * as kdbxweb from 'kdbxweb';
import { Database, Group, Entry, EntryVersion, Attachment, CustomField } from '../types/database';
import { userSettingsService } from './UserSettingsService';
import { HistoryNotesService } from './HistoryNotesService';

interface SaveResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

interface LoadLastDatabaseResult {
    file: File | null;
    databasePath: string | null;
    biometricsEnabled: boolean;
}

// Lookup tables for one save pass; see indexDatabase
interface KdbxIndex {
    entries: Map<string, kdbxweb.KdbxEntry>;
    groups: Map<string, kdbxweb.KdbxGroup>;
}

export type SearchField = 'any' | 'title' | 'username' | 'url' | 'notes' | 'tag';

export interface SearchTerm {
    field: SearchField;
    value: string;
}

export interface KdfInfo {
    type: 'argon2d' | 'argon2id' | 'aes' | 'aes-kdbx3';
    iterations: number;
    memoryMiB?: number;
    parallelism?: number;
}

export class KeepassDatabaseService {
    // Fields with dedicated UI; everything else on a kdbx entry is a custom field
    static readonly STANDARD_FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

    private static currentPath: string | undefined;
    // mtime of the database file when we last read or wrote it; the cheap
    // first check for edits made outside Vigil before overwriting the file
    private static lastKnownMtimeMs: number | undefined;
    // Digest of those same bytes. A changed mtime is a hint, not evidence:
    // sync clients, backup tools and editors all touch a file without
    // changing it, and merging on that alone means merging the file with
    // itself and telling the user their database changed when it did not
    private static lastKnownHash: string | undefined;
    // Bumped by every setPath, so a slow stat belonging to a previous vault
    // cannot land on the current one
    private static pathGeneration = 0;
    // Objects in the kdbx that no applied UI model may delete yet: brought in
    // by a merge from disk, or written directly by the browser integration.
    // The save walk rebuilds every group from the model, so anything the
    // model lacks is dropped and tombstoned as a deletion; a model built
    // before the object existed lacks it through no choice of the user.
    //
    // The value is the generation of the first model built after the object
    // appeared (undefined while no model has been built since). Every model
    // carries the generation it was built at, so a save can tell "this model
    // predates the object" (protect it) from "this model knew the object and
    // the user removed it" (a deletion to honour). Submission order cannot
    // stand in for this: a save queued from stale React state arrives after
    // a fresher one
    private static unseenUuids = new Map<string, number | undefined>();
    private static modelGeneration = 0;

    // Whether the loaded file holds changes no UI model has been built from
    static hasUnseenMergedChanges(): boolean {
        for (const seenAt of this.unseenUuids.values()) {
            if (seenAt === undefined) return true;
        }
        return false;
    }

    // Called by writers that put objects into the kdbx without going through
    // a UI model (browser integration set-login, passkey registration), so a
    // save applying an older model does not tombstone what they created
    static registerUnmodeledUuids(uuids: string[]): void {
        for (const uuid of uuids) {
            if (!this.unseenUuids.has(uuid)) this.unseenUuids.set(uuid, undefined);
        }
    }

    // Asks the user whether an unmergeable external change may be overwritten.
    // App registers a dialog-backed resolver; without one the answer is no
    static conflictResolver: ((message: string) => Promise<boolean>) | undefined;

    // Same ledger idea for VALUES of existing entries: the browser updating a
    // stored login rewrites fields on the kdbx object directly, and a save
    // applying a model built before that write would push the old values back
    // (archiving the new ones into history and telling nobody). An entry
    // listed here is written out as the kdbx holds it whenever the model is
    // older than the first one that carried the new values. The cost, taken
    // deliberately: a user edit to the SAME entry racing the browser's update
    // loses to it; the alternative silently undoes a write the extension was
    // told succeeded whenever any UI save races it
    private static unmodeledEditUuids = new Map<string, number | undefined>();

    // Converted entry models keyed by their kdbx object; see convertEntry in
    // convertKdbxToDatabase. WeakMap: closing a vault drops the entries and
    // their models with them
    private static convertedEntryCache = new WeakMap<kdbxweb.KdbxEntry, { key: string; model: Entry }>();

    static registerUnmodeledEdits(uuids: string[]): void {
        for (const uuid of uuids) {
            this.unmodeledEditUuids.set(uuid, undefined);
        }
    }

    private static async hashBytes(bytes: Uint8Array): Promise<string> {
        const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    static setPath(path: string | undefined, loadedBytes?: Uint8Array) {
        const generation = ++this.pathGeneration;
        this.currentPath = path;
        this.lastKnownMtimeMs = undefined;
        this.lastKnownHash = undefined;
        // Closing the vault: the unmodeled-object ledgers belong to it
        if (path === undefined) {
            this.unseenUuids.clear();
            this.unmodeledEditUuids.clear();
        }
        if (!path || !window.electron) return;

        // The bytes the vault was opened from are the content baseline; when
        // the caller hands them over there is no second read to race or fail
        if (loadedBytes) {
            this.hashBytes(loadedBytes).then(hash => {
                if (this.pathGeneration === generation && this.lastKnownHash === undefined) {
                    this.lastKnownHash = hash;
                }
            }).catch(() => {});
        }

        // A save can complete before these land. When it does its baseline is
        // the newer one, so these only ever fill in a blank, never overwrite
        window.electron.statFile(path).then(stat => {
            if (stat.success && this.pathGeneration === generation && this.lastKnownMtimeMs === undefined) {
                this.lastKnownMtimeMs = stat.mtimeMs;
            }
        }).catch(() => {});

        if (loadedBytes) return;
        window.electron.readFile(path).then(async result => {
            if (!result.success || !result.data) return;
            const hash = await this.hashBytes(new Uint8Array(result.data));
            if (this.pathGeneration === generation && this.lastKnownHash === undefined) {
                this.lastKnownHash = hash;
            }
        }).catch(() => {});
    }

    static getPath(): string | undefined {
        return this.currentPath;
    }

    // Title, UserName, URL and Notes are plain strings in the UI model, but the
    // file may hold any of them as a ProtectedValue: KeePass has a database
    // wide memory-protection setting for each. ProtectedValue.toString()
    // returns base64 of the obfuscated bytes rather than the text, so reading
    // one that way shows ciphertext in the UI and writes it back as the value
    // on the next save. getText() is the accessor; undefined stays undefined
    // so a field the entry does not have is not created as an empty one
    private static standardField(entry: kdbxweb.KdbxEntry, name: string): string | undefined {
        const value = entry.fields.get(name);
        if (value === undefined) return undefined;
        return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
    }

    // Which of those four the file protects, so the save can put them back the
    // way they came in. Password is excluded: it is always written protected
    private static protectedStandardFields(entry: kdbxweb.KdbxEntry): string[] {
        return this.STANDARD_FIELDS.filter(name =>
            name !== 'Password' && entry.fields.get(name) instanceof kdbxweb.ProtectedValue
        );
    }

    // What a brand new entry should protect, from the database's own memory
    // protection settings. kdbxweb's createEntry seeds its fields from these,
    // and the save below overwrites every one of them, so without this a new
    // entry in a vault that protects Notes would come out unprotected
    private static defaultProtectedFields(kdbxDb: kdbxweb.Kdbx): Set<string> {
        const protection = kdbxDb.meta.memoryProtection ?? {};
        const names = new Set<string>();
        if (protection.title) names.add('Title');
        if (protection.userName) names.add('UserName');
        if (protection.url) names.add('URL');
        if (protection.notes) names.add('Notes');
        return names;
    }

    static convertKdbxToDatabase(kdbxDb: kdbxweb.Kdbx): Database {
        // The model built here carries everything in the file, merged and
        // browser-written objects included; from this generation onward their
        // absence from a model is a choice. Models still in flight from
        // before this generation keep protecting them
        const generation = ++this.modelGeneration;
        for (const [uuid, seenAt] of this.unseenUuids) {
            if (seenAt === undefined) this.unseenUuids.set(uuid, generation);
        }
        for (const [uuid, seenAt] of this.unmodeledEditUuids) {
            if (seenAt === undefined) this.unmodeledEditUuids.set(uuid, generation);
        }

        const convertAttachments = (entry: kdbxweb.KdbxEntry): Attachment[] =>
            [...entry.binaries].map(([name, binary]) => ({
                name,
                // kdbx4 wraps binaries as { hash, value }, kdbx3 stores them raw
                data: (binary as kdbxweb.KdbxBinaryWithHash).value ?? binary,
            }));

        const convertCustomFields = (entry: kdbxweb.KdbxEntry): CustomField[] =>
            [...entry.fields]
                .filter(([key]) => !KeepassDatabaseService.STANDARD_FIELDS.includes(key))
                .map(([key, value]) => ({
                    key,
                    value,
                    protected: value instanceof kdbxweb.ProtectedValue,
                }));

        const convertVersion = (entry: kdbxweb.KdbxEntry): EntryVersion => ({
            title: KeepassDatabaseService.standardField(entry, 'Title') || '',
            username: KeepassDatabaseService.standardField(entry, 'UserName') || '',
            password: entry.fields.get('Password') || '',
            url: KeepassDatabaseService.standardField(entry, 'URL'),
            notes: KeepassDatabaseService.standardField(entry, 'Notes'),
            protectedFields: KeepassDatabaseService.protectedStandardFields(entry),
            modified: entry.times.lastModTime as Date,
            attachments: convertAttachments(entry),
            expires: !!entry.times.expires,
            expiryTime: entry.times.expiryTime as Date | undefined,
            customFields: convertCustomFields(entry),
            tags: [...entry.tags],
        });

        const recycleBinId = kdbxDb.meta.recycleBinUuid?.toString();

        // Rebuilding a model used to convert every entry and every history
        // revision on every save. Unchanged entries (nearly all of them, on a
        // typical save) reuse their previous model object instead: any write
        // path bumps lastModTime, pushHistory grows history, and a move bumps
        // locationChanged, so this key changes whenever the model would.
        // Reused models are shared across converts and must never be mutated
        // in place, which the model-mutating helpers already honour by
        // copying
        const entryCacheKey = (entry: kdbxweb.KdbxEntry): string =>
            `${entry.times.lastModTime?.getTime() ?? 0}:${entry.history.length}:${entry.times.locationChanged?.getTime() ?? 0}:${entry.previousParentGroup ?? ''}`;

        const convertEntry = (entry: kdbxweb.KdbxEntry): Entry => {
            const key = entryCacheKey(entry);
            const cached = KeepassDatabaseService.convertedEntryCache.get(entry);
            if (cached && cached.key === key) return cached.model;
            const model: Entry = {
                ...convertVersion(entry),
                id: entry.uuid.toString(),
                previousParentGroup: entry.previousParentGroup?.toString(),
                created: entry.times.creationTime as Date,
                history: entry.history.map(convertVersion),
            };
            KeepassDatabaseService.convertedEntryCache.set(entry, { key, model });
            return model;
        };

        const convertGroup = (group: kdbxweb.KdbxGroup): Group => {
            return {
                id: group.uuid.toString(),
                isRecycleBin: !!recycleBinId && group.uuid.toString() === recycleBinId,
                name: group.name as string,
                groups: group.groups.map(g => convertGroup(g)),
                entries: group.entries.map(convertEntry),
            };
        };

        const root = convertGroup(kdbxDb.getDefaultGroup());
        return {
            name: kdbxDb.meta.name || 'KeePass Database',
            groups: root.groups,
            root: {
                ...root,
                name: 'All Entries'
            },
            generation,
        };
    }

    static createNewEntry(): Entry {
        return {
            id: '',
            title: '',
            username: '',
            password: '',
            url: '',
            notes: '',
            created: new Date(),
            modified: new Date(),
            attachments: [],
            history: [],
            expires: false,
            customFields: [],
            tags: [],
        };
    }

    // kdbx keeps tags as one string split on /\s*[;,:]\s*/, so a tag carrying
    // any of those delimiters would come back as two after a reload. Trimmed,
    // stripped, emptied and de-duplicated case-insensitively, first spelling wins
    static normalizeTags(tags: string[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const raw of tags) {
            const tag = raw.replace(/[;,:]/g, '').trim();
            if (!tag) continue;
            const key = tag.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(tag);
        }
        return result;
    }

    // Every tag in use, for the suggestion list on the entry form
    static collectTags(root: Group): string[] {
        const seen = new Map<string, string>();
        const walk = (group: Group) => {
            if (group.isRecycleBin) return;
            for (const entry of group.entries) {
                for (const tag of entry.tags ?? []) {
                    const key = tag.toLowerCase();
                    if (!seen.has(key)) seen.set(key, tag);
                }
            }
            group.groups.forEach(walk);
        };
        walk(root);
        return [...seen.values()].sort((a, b) => a.localeCompare(b));
    }

    static getFieldString(value: string | kdbxweb.ProtectedValue): string {
        return typeof value === 'string' ? value : value.getText();
    }

    static isEntryExpired(entry: { expires: boolean; expiryTime?: Date }): boolean {
        return entry.expires && !!entry.expiryTime && entry.expiryTime.getTime() <= Date.now();
    }

    static findExpiredEntries(root: Group): Array<{ entry: Entry; group: Group }> {
        const expired: Array<{ entry: Entry; group: Group }> = [];
        const walk = (group: Group) => {
            if (group.isRecycleBin) return;
            group.entries.forEach(entry => {
                if (this.isEntryExpired(entry)) {
                    expired.push({ entry, group });
                }
            });
            group.groups.forEach(walk);
        };
        walk(root);
        return expired;
    }

    static getAttachmentBytes(attachment: Attachment): Uint8Array {
        if (attachment.data instanceof kdbxweb.ProtectedValue) {
            return attachment.data.getBinary();
        }
        return new Uint8Array(attachment.data);
    }

    static getAttachmentSize(attachment: Attachment): number {
        return attachment.data.byteLength;
    }

    static formatAttachmentSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    static getPasswordString(password: string | kdbxweb.ProtectedValue): string {
        if (typeof password === 'string') {
            return password;
        }
        return password.getText();
    }

    static prepareEntryForSave(entry: Entry): Entry {
        return {
            ...entry,
            modified: new Date(),
            password: typeof entry.password === 'string'
                ? kdbxweb.ProtectedValue.fromString(entry.password)
                : entry.password
        };
    }

    static getAllEntriesFromGroup(group: Group): Entry[] {
        let entries = [...group.entries];
        group.groups.forEach(subgroup => {
            // Deleted entries stay out of aggregate views; the bin's own
            // contents show only when the bin itself is selected
            if (subgroup.isRecycleBin) return;
            entries = entries.concat(this.getAllEntriesFromGroup(subgroup));
        });
        return entries;
    }

    // Prefixes that scope a search term to one field. A tag can hold no colon
    // (see normalizeTags), so "tag:x" is never ambiguous, and an unknown prefix
    // falls through to a plain term, which is what keeps a pasted "https://host"
    // searching for the URL rather than for nothing
    private static readonly SEARCH_FIELDS: Record<string, SearchField> = {
        title: 'title',
        user: 'username',
        username: 'username',
        url: 'url',
        notes: 'notes',
        note: 'notes',
        tag: 'tag',
    };

    // Whitespace separated, with double quotes holding a phrase together so
    // tags and titles with spaces are reachable: tag:"home lab", "acme corp"
    private static tokenizeQuery(query: string): string[] {
        const tokens: string[] = [];
        let current = '';
        let quoted = false;
        for (const char of query) {
            if (char === '"') {
                quoted = !quoted;
                continue;
            }
            if (!quoted && /\s/.test(char)) {
                if (current) tokens.push(current);
                current = '';
                continue;
            }
            current += char;
        }
        if (current) tokens.push(current);
        return tokens;
    }

    static parseSearchQuery(query: string): SearchTerm[] {
        return this.tokenizeQuery(query).map(token => {
            const colon = token.indexOf(':');
            if (colon > 0) {
                const field = this.SEARCH_FIELDS[token.slice(0, colon).toLowerCase()];
                const value = token.slice(colon + 1).trim().toLowerCase();
                if (field && value) return { field, value };
            }
            return { field: 'any' as const, value: token.toLowerCase() };
        });
    }

    private static matchesTerm(entry: Entry, term: SearchTerm): boolean {
        const has = (value: string | undefined) => !!value && value.toLowerCase().includes(term.value);
        const taggedWith = () => (entry.tags ?? []).some(tag => tag.toLowerCase().includes(term.value));

        switch (term.field) {
            case 'title': return has(entry.title);
            case 'username': return has(entry.username);
            case 'url': return has(entry.url);
            case 'notes': return has(entry.notes);
            case 'tag': return taggedWith();
            default:
                if (has(entry.title) || has(entry.username) || has(entry.url) || has(entry.notes)) return true;
                if (taggedWith()) return true;
                // Field names always, values only when they are not protected:
                // a bare word should not quietly match somebody's stored secret
                return (entry.customFields ?? []).some(field =>
                    has(field.key) || (!field.protected && has(this.getFieldString(field.value))));
        }
    }

    static filterEntries(entries: Entry[], searchQuery: string): Entry[] {
        if (!searchQuery.trim()) return entries;

        const terms = this.parseSearchQuery(searchQuery);
        if (terms.length === 0) return entries;

        return entries.filter(entry => terms.every(term => this.matchesTerm(entry, term)));
    }

    static sortEntriesByTitle(entries: Entry[]): Entry[] {
        return [...entries].sort((a, b) =>
            a.title.toLowerCase().localeCompare(b.title.toLowerCase())
        );
    }

    static getEntriesForDisplay(group: Group, _database: Database | undefined, searchQuery: string): Entry[] {
        const baseEntries = this.getAllEntriesFromGroup(group);
        const filteredEntries = this.filterEntries(baseEntries, searchQuery);
        return this.sortEntriesByTitle(filteredEntries);
    }

    static getUrlHostname(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    }

    // Deep copy helper that preserves Date objects and ProtectedValue objects
    static deepCopyWithDates(obj: any): any {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj);
        if (obj instanceof kdbxweb.ProtectedValue) return obj;
        if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) return obj;
        if (Array.isArray(obj)) {
            return obj.map(item => this.deepCopyWithDates(item));
        }

        const copy: any = {};
        Object.entries(obj).forEach(([key, value]) => {
            copy[key] = this.deepCopyWithDates(value);
        });
        return copy;
    }

    static findGroupInDatabase(groupId: string, root: Group): Group | null {
        if (root.id === groupId) {
            return root;
        }

        for (const subgroup of root.groups) {
            const found = this.findGroupInDatabase(groupId, subgroup);
            if (found) {
                return found;
            }
        }

        return null;
    }

    static countEntriesInGroup(group: Group): number {
        let count = group.entries.length;
        group.groups.forEach(subgroup => {
            if (subgroup.isRecycleBin) return;
            count += this.countEntriesInGroup(subgroup);
        });
        return count;
    }

    static isGroupInHierarchy(targetGroup: Group, potentialParent: Group): boolean {
        if (targetGroup.id === potentialParent.id) return true;
        return potentialParent.groups.some(g => this.isGroupInHierarchy(targetGroup, g));
    }

    static findGroupContainingEntry(entryId: string, root: Group): Group | null {
        if (root.entries.some(e => e.id === entryId)) {
            return root;
        }
        for (const subgroup of root.groups) {
            const found = this.findGroupContainingEntry(entryId, subgroup);
            if (found) return found;
        }
        return null;
    }

    static findEntry(entryId: string, root: Group): [Entry | null, Group | null] {
        const group = this.findGroupContainingEntry(entryId, root);
        if (!group) return [null, null];

        const entry = group.entries.find(e => e.id === entryId);
        return entry ? [entry, group] : [null, null];
    }

    static updateGroupName(database: Database, group: Group, newName: string): Database {
        const updatedDatabase: Database = this.deepCopyWithDates(database);
        const updateGroupNameInner = (searchGroup: Group): boolean => {
            if (searchGroup.id === group.id) {
                searchGroup.name = newName;
                return true;
            }
            for (const subgroup of searchGroup.groups) {
                if (updateGroupNameInner(subgroup)) return true;
            }
            return false;
        };

        updateGroupNameInner(updatedDatabase.root);
        return updatedDatabase;
    }

    static addNewGroup(database: Database, parentGroup: Group): Database {
        const newGroup: Group = {
            id: '',
            name: "New Group",
            groups: [],
            entries: [],
        };

        const updatedDatabase: Database = this.deepCopyWithDates(database);
        const findAndUpdateGroup = (group: Group): boolean => {
            if (group.id === parentGroup.id) {
                group.groups.push(newGroup);
                return true;
            }
            for (const subgroup of group.groups) {
                if (findAndUpdateGroup(subgroup)) return true;
            }
            return false;
        };

        findAndUpdateGroup(updatedDatabase.root);
        return updatedDatabase;
    }

    static removeGroup(database: Database, groupToRemove: Group): Database {
        if (groupToRemove.id === database.root.id) return database;

        const updatedDatabase: Database = this.deepCopyWithDates(database);
        // The bin itself, or anything inside it, is deleted for real;
        // everything else moves into the bin
        const permanent = this.isGroupInRecycleBin(updatedDatabase, groupToRemove);

        let removedGroup: Group | null = null;
        const removeGroupFromParent = (group: Group): boolean => {
            const index = group.groups.findIndex(g => g.id === groupToRemove.id);
            if (index !== -1) {
                [removedGroup] = group.groups.splice(index, 1);
                return true;
            }
            for (const subgroup of group.groups) {
                if (removeGroupFromParent(subgroup)) return true;
            }
            return false;
        };

        removeGroupFromParent(updatedDatabase.root);
        updatedDatabase.groups = updatedDatabase.groups.filter((g: Group) => g.id !== groupToRemove.id);

        if (!permanent && removedGroup) {
            this.getOrCreateRecycleBin(updatedDatabase.root).groups.push(removedGroup);
        }

        return updatedDatabase;
    }

    static moveGroup(database: Database, groupToMove: Group, newParent: Group): Database {
        // Don't allow moving to itself, root, or a descendant
        if (groupToMove.id === newParent.id ||
            newParent.id === database.root.id ||
            this.isGroupInHierarchy(newParent, groupToMove)) {
            return database;
        }

        const updatedDatabase: Database = this.deepCopyWithDates(database);

        const removeFromCurrentParent = (searchGroup: Group): boolean => {
            const index = searchGroup.groups.findIndex(g => g.id === groupToMove.id);
            if (index !== -1) {
                searchGroup.groups.splice(index, 1);
                return true;
            }
            for (const subgroup of searchGroup.groups) {
                if (removeFromCurrentParent(subgroup)) return true;
            }
            return false;
        };

        const findNewParent = (searchGroup: Group): Group | null => {
            if (searchGroup.id === newParent.id) {
                return searchGroup;
            }
            for (const subgroup of searchGroup.groups) {
                const found = findNewParent(subgroup);
                if (found) return found;
            }
            return null;
        };

        removeFromCurrentParent(updatedDatabase.root);
        const targetParent = findNewParent(updatedDatabase.root);
        if (targetParent) {
            targetParent.groups.push(groupToMove);
        }

        return updatedDatabase;
    }

    static saveEntry(database: Database, entry: Entry, selectedGroup: Group, isCreatingNew: boolean): [Database, Entry] {
        // Copies only the path from the root down to the changed group. This
        // used to deep-copy the entire model (every entry, every history
        // revision) per save; untouched entries and groups now keep their
        // object identity, which the convert cache and the identity checks in
        // the save path lean on
        let savedEntry = entry;
        if (isCreatingNew) {
            // Assign the entry its definitive kdbx UUID up front so later
            // edits and saves address the same entry
            savedEntry = { ...entry, id: kdbxweb.KdbxUuid.random().toString() };
        }

        const isTarget = isCreatingNew
            ? (group: Group) => group.id === selectedGroup.id
            : (group: Group) => group.entries.some(e => e.id === entry.id);
        const applyTo = isCreatingNew
            ? (group: Group): Group => ({ ...group, entries: [...group.entries, savedEntry] })
            : (group: Group): Group => ({ ...group, entries: group.entries.map(e => (e.id === entry.id ? savedEntry : e)) });

        const rebuild = (group: Group): Group | null => {
            if (isTarget(group)) return applyTo(group);
            for (let i = 0; i < group.groups.length; i++) {
                const child = rebuild(group.groups[i]);
                if (child) {
                    const groups = group.groups.slice();
                    groups[i] = child;
                    return { ...group, groups };
                }
            }
            return null;
        };

        let root = rebuild(database.root);
        // A new entry whose group is not in the tree lands at the root, as
        // the deep-copy version did
        if (!root && isCreatingNew) root = applyTo(database.root);
        if (!root) return [{ ...database }, savedEntry];
        return [{ ...database, root, groups: root.groups }, savedEntry];
    }

    static findRecycleBin(root: Group): Group | null {
        if (root.isRecycleBin) return root;
        for (const subgroup of root.groups) {
            const found = this.findRecycleBin(subgroup);
            if (found) return found;
        }
        return null;
    }

    static isEntryInRecycleBin(database: Database, entryId: string): boolean {
        const bin = this.findRecycleBin(database.root);
        if (!bin) return false;
        return !!this.findGroupContainingEntry(entryId, bin);
    }

    static isGroupInRecycleBin(database: Database, group: Group): boolean {
        const bin = this.findRecycleBin(database.root);
        if (!bin) return false;
        return this.isGroupInHierarchy(group, bin);
    }

    // Where an entry sitting in the recycle bin goes when it is restored: the
    // group it was moved out of, as long as that group is still there and is
    // not itself in the bin. Anything else falls back to the root, which is
    // where every restore used to land
    static restoreTargetGroup(database: Database, entry: Entry): Group {
        const previousId = entry.previousParentGroup;
        if (!previousId || previousId === database.root.id) return database.root;

        const previous = this.findGroupInDatabase(previousId, database.root);
        if (!previous || this.isGroupInRecycleBin(database, previous)) return database.root;
        return previous;
    }

    private static getOrCreateRecycleBin(root: Group): Group {
        const existing = this.findRecycleBin(root);
        if (existing) return existing;

        const bin: Group = {
            id: '',
            name: 'Recycle Bin',
            groups: [],
            entries: [],
            isRecycleBin: true,
        };
        root.groups.push(bin);
        return bin;
    }

    static emptyRecycleBin(database: Database): Database {
        const updatedDatabase: Database = this.deepCopyWithDates(database);
        const bin = this.findRecycleBin(updatedDatabase.root);
        if (bin) {
            bin.entries = [];
            bin.groups = [];
        }
        return updatedDatabase;
    }

    static removeEntry(database: Database, entryToRemove: Entry): Database {
        const updatedDatabase: Database = this.deepCopyWithDates(database);
        // Already in the recycle bin: delete for real, otherwise move it there
        const permanent = this.isEntryInRecycleBin(updatedDatabase, entryToRemove.id);

        let removedEntry: Entry | null = null;
        const removeEntryFromGroup = (group: Group): boolean => {
            const index = group.entries.findIndex(e => e.id === entryToRemove.id);
            if (index !== -1) {
                [removedEntry] = group.entries.splice(index, 1);
                return true;
            }
            for (const subgroup of group.groups) {
                if (removeEntryFromGroup(subgroup)) return true;
            }
            return false;
        };

        removeEntryFromGroup(updatedDatabase.root);

        if (!permanent && removedEntry) {
            this.getOrCreateRecycleBin(updatedDatabase.root).entries.push(removedEntry);
        }

        return updatedDatabase;
    }

    static moveEntry(database: Database, entryToMove: Entry, targetGroup: Group): Database {
        // Don't move to the same group
        const sourceGroup = this.findGroupContainingEntry(entryToMove.id, database.root);
        if (!sourceGroup || sourceGroup.id === targetGroup.id) {
            return database;
        }

        const updatedDatabase: Database = this.deepCopyWithDates(database);

        const removeEntryFromGroup = (group: Group): boolean => {
            const index = group.entries.findIndex(e => e.id === entryToMove.id);
            if (index !== -1) {
                group.entries.splice(index, 1);
                return true;
            }
            for (const subgroup of group.groups) {
                if (removeEntryFromGroup(subgroup)) return true;
            }
            return false;
        };

        const findTargetGroup = (group: Group): Group | null => {
            if (group.id === targetGroup.id) {
                return group;
            }
            for (const subgroup of group.groups) {
                const found = findTargetGroup(subgroup);
                if (found) return found;
            }
            return null;
        };

        removeEntryFromGroup(updatedDatabase.root);
        const target = findTargetGroup(updatedDatabase.root);
        if (target) {
            target.entries.push(entryToMove);
        }

        return updatedDatabase;
    }

    static async loadLastDatabase(): Promise<LoadLastDatabaseResult> {
        if (!window.electron) {
            return { file: null, databasePath: null, biometricsEnabled: false };
        }

        try {
            const lastPath = await window.electron.getLastDatabasePath();
            if (!lastPath) {
                return { file: null, databasePath: null, biometricsEnabled: false };
            }

            const result = await window.electron.readFile(lastPath);
            if (!result.success || !result.data) {
                return { file: null, databasePath: null, biometricsEnabled: false };
            }

            const file = new File([result.data], lastPath.split('/').pop() || 'database.kdbx');
            let biometricsEnabled = false;

            const available = await window.electron.isBiometricsAvailable();
            if (available) {
                const biometricsResult = await window.electron.hasBiometricsEnabled(lastPath);
                if (biometricsResult.success) {
                    biometricsEnabled = biometricsResult.enabled || false;
                }
            }

            return {
                file,
                databasePath: lastPath,
                biometricsEnabled
            };
        } catch (err) {
            console.error('Failed to load last database:', err);
            return { file: null, databasePath: null, biometricsEnabled: false };
        }
    }

    static async checkBiometricsForFile(filePath: string): Promise<boolean> {
        if (!window.electron) return false;

        try {
            const available = await window.electron.isBiometricsAvailable();
            if (!available) return false;

            const biometricsResult = await window.electron.hasBiometricsEnabled(filePath);
            return biometricsResult.success ? (biometricsResult.enabled || false) : false;
        } catch (err) {
            console.error('Failed to check biometrics status:', err);
            return false;
        }
    }

    private static attachmentsChanged(kdbxEntry: kdbxweb.KdbxEntry, attachments: Attachment[]): boolean {
        if (kdbxEntry.binaries.size !== attachments.length) return true;

        for (const attachment of attachments) {
            const existing = kdbxEntry.binaries.get(attachment.name);
            if (!existing) return true;

            const existingData = (existing as kdbxweb.KdbxBinaryWithHash).value ?? existing;
            // Untouched attachments keep their object identity through the UI model
            if (existingData === attachment.data) continue;

            const a = this.getAttachmentBytes(attachment);
            const b = existingData instanceof kdbxweb.ProtectedValue
                ? existingData.getBinary()
                : new Uint8Array(existingData as ArrayBuffer);
            if (a.length !== b.length) return true;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return true;
            }
        }

        return false;
    }

    private static entryChanged(kdbxEntry: kdbxweb.KdbxEntry, entry: Entry): boolean {
        // Through standardField, so a protected field is compared as its text
        // rather than as the base64 of its obfuscated bytes; comparing the
        // latter against the model would call every such entry changed on
        // every save and push a history revision for nothing
        const field = (name: string) => this.standardField(kdbxEntry, name) ?? '';
        if (field('Title') !== entry.title) return true;
        if (field('UserName') !== entry.username) return true;
        if (field('URL') !== (entry.url ?? '')) return true;
        if (field('Notes') !== (entry.notes ?? '')) return true;

        // Turning protection on or off is an edit even when the text is equal
        const wasProtected = this.protectedStandardFields(kdbxEntry);
        const nowProtected = (entry.protectedFields ?? []).filter(name => name !== 'Password');
        if (wasProtected.length !== nowProtected.length) return true;
        if (wasProtected.some(name => !nowProtected.includes(name))) return true;

        const existingPassword = kdbxEntry.fields.get('Password');
        // The model's ProtectedValue is the very object read out of the kdbx
        // unless the entry was edited (prepareEntryForSave wraps a fresh one),
        // so identity equality is an unchanged password with no decrypt. This
        // is what keeps a full-vault save from decrypting every password
        if (existingPassword !== entry.password) {
            const oldPassword = existingPassword ? this.getPasswordString(existingPassword as string | kdbxweb.ProtectedValue) : '';
            if (oldPassword !== this.getPasswordString(entry.password)) return true;
        }

        if (!!kdbxEntry.times.expires !== !!entry.expires) return true;
        if ((kdbxEntry.times.expiryTime?.getTime() ?? 0) !== (entry.expiryTime?.getTime() ?? 0)) return true;

        if (this.customFieldsChanged(kdbxEntry, entry.customFields ?? [])) return true;

        const tags = this.normalizeTags(entry.tags ?? []);
        if (kdbxEntry.tags.length !== tags.length) return true;
        if (kdbxEntry.tags.some((tag, i) => tag !== tags[i])) return true;

        return this.attachmentsChanged(kdbxEntry, entry.attachments ?? []);
    }

    private static customFieldsChanged(kdbxEntry: kdbxweb.KdbxEntry, customFields: CustomField[]): boolean {
        const existing = [...kdbxEntry.fields].filter(([key]) => !this.STANDARD_FIELDS.includes(key));
        if (existing.length !== customFields.length) return true;

        for (let i = 0; i < customFields.length; i++) {
            const [key, value] = existing[i];
            const field = customFields[i];
            if (key !== field.key) return true;
            if ((value instanceof kdbxweb.ProtectedValue) !== field.protected) return true;
            // Identity first: unchanged protected values compare without a
            // decrypt (see the password check in entryChanged)
            if (value !== field.value && this.getFieldString(value) !== this.getFieldString(field.value)) return true;
        }

        return false;
    }

    // Every entry and group in the file, by UUID. The save walk resolves
    // against this rather than against the group it is currently writing, so
    // an object the user dragged elsewhere (or deleted into the recycle bin)
    // is found where it used to live and moved, instead of being rebuilt from
    // the UI model and losing everything the model does not carry
    private static indexDatabase(root: kdbxweb.KdbxGroup): KdbxIndex {
        const index: KdbxIndex = { entries: new Map(), groups: new Map() };
        const walk = (kdbxGroup: kdbxweb.KdbxGroup) => {
            index.groups.set(kdbxGroup.uuid.toString(), kdbxGroup);
            for (const entry of kdbxGroup.entries) {
                index.entries.set(entry.uuid.toString(), entry);
            }
            for (const child of kdbxGroup.groups) walk(child);
        };
        walk(root);
        return index;
    }

    private static collectUuids(root: kdbxweb.KdbxGroup): Set<string> {
        const uuids = new Set<string>();
        const walk = (group: kdbxweb.KdbxGroup) => {
            uuids.add(group.uuid.toString());
            group.entries.forEach(e => uuids.add(e.uuid.toString()));
            group.groups.forEach(walk);
        };
        walk(root);
        return uuids;
    }

    // After the save walk the index holds what the model did not claim. Those
    // among them that a merge brought in and no model has carried yet are put
    // back where the file has them, instead of being written out as deleted.
    // Without this, a save that merged and then failed (or a save queued
    // behind the merging one) applies its pre-merge model to the merged file
    // and tombstones every merged object; the tombstone then travels to the
    // replica that made the change and deletes it there too
    private static keepUnseenMerged(root: kdbxweb.KdbxGroup, index: KdbxIndex, unseen: Set<string>): void {
        if (unseen.size === 0) return;

        // Membership, not parentGroup: a dropped object still points at its
        // old parent, it is just no longer in that parent's list
        const inTree = (object: kdbxweb.KdbxEntry | kdbxweb.KdbxGroup): boolean => {
            let node: kdbxweb.KdbxEntry | kdbxweb.KdbxGroup = object;
            while (node !== root) {
                const parent = node.parentGroup;
                if (!parent) return false;
                const siblings: (kdbxweb.KdbxEntry | kdbxweb.KdbxGroup)[] = node instanceof kdbxweb.KdbxGroup ? parent.groups : parent.entries;
                if (!siblings.includes(node)) return false;
                node = parent;
            }
            return true;
        };
        const homeFor = (object: kdbxweb.KdbxEntry | kdbxweb.KdbxGroup): kdbxweb.KdbxGroup =>
            object.parentGroup && inTree(object.parentGroup) ? object.parentGroup : root;

        // Groups first, in file order, so a merged subtree comes back whole
        // and its entries are found inside it
        for (const [uuid, group] of index.groups) {
            if (!unseen.has(uuid) || inTree(group)) continue;
            const parent = homeFor(group);
            this.reparent(group, parent);
            parent.groups.push(group);
        }
        for (const [uuid, entry] of index.entries) {
            if (!unseen.has(uuid) || inTree(entry)) continue;
            const parent = homeFor(entry);
            this.reparent(entry, parent);
            parent.entries.push(entry);
        }
    }

    // Same bookkeeping kdbxweb's own move() does. previousParentGroup is what
    // KeePass uses to restore an item out of the recycle bin, and
    // locationChanged is what a merge compares to decide which parent wins
    private static reparent(object: kdbxweb.KdbxEntry | kdbxweb.KdbxGroup, newParent: kdbxweb.KdbxGroup): void {
        if (object.parentGroup === newParent) return;
        object.previousParentGroup = object.parentGroup?.uuid;
        object.parentGroup = newParent;
        object.times.locationChanged = new Date();
        // Timestamps have millisecond resolution: two moves inside one
        // millisecond would leave the converted-model cache key unchanged, so
        // the writer invalidates explicitly instead of trusting the clock
        if (object instanceof kdbxweb.KdbxEntry) this.convertedEntryCache.delete(object);
    }

    private static async updateGroup(group: Group, kdbxGroup: kdbxweb.KdbxGroup, kdbxDb: kdbxweb.Kdbx, index: KdbxIndex, isRoot = false, frozen: Set<string> = new Set()): Promise<void> {
        // The UI labels the root group "All Entries"; never write that label
        // over the real group name stored in the file
        if (!isRoot && kdbxGroup.name !== group.name) {
            kdbxGroup.name = group.name;
            // A merge settles a name conflict by comparing lastModTime, and
            // nothing else here moves a group's clock. Without this a rename
            // keeps the timestamp it had before, so an older rename from
            // another replica outranks it and silently wins. Only on an
            // actual change: bumping every save would make this replica win
            // every conflict instead
            kdbxGroup.times.lastModTime = new Date();
        }

        // Process all entries in one pass
        const updatedEntries: kdbxweb.KdbxEntry[] = [];
        for (const entry of group.entries) {
            let kdbxEntry = entry.id ? index.entries.get(entry.id) : undefined;
            if (kdbxEntry) {
                // Claimed, so a UUID appearing twice in the model cannot put
                // one kdbx object into two groups
                index.entries.delete(entry.id);
                // The entry may have come from another group. Reparenting the
                // existing object keeps its history, tags and everything else
                // the UI model does not carry; recreating it would drop them
                this.reparent(kdbxEntry, kdbxGroup);
                // The kdbx holds values written outside any model (browser
                // set-login on an existing entry) and this model predates
                // them: keep the entry as the file has it
                if (frozen.has(entry.id)) {
                    updatedEntries.push(kdbxEntry);
                    continue;
                }
                // Untouched entries keep their kdbx object as-is: no field
                // rewrites, no attachment re-hashing, no history snapshot.
                // A move is a location change, not a field change, so it
                // records no revision of its own
                if (!this.entryChanged(kdbxEntry, entry)) {
                    updatedEntries.push(kdbxEntry);
                    continue;
                }
                kdbxEntry.pushHistory();
                // Same reasoning as in reparent: a rewrite inside the same
                // millisecond as the last one (retention can hold history
                // length constant too) must not leave a stale cached model
                this.convertedEntryCache.delete(kdbxEntry);
            } else {
                kdbxEntry = kdbxDb.createEntry(kdbxGroup);
                if (entry.id) {
                    // Keep the UUID assigned when the entry was created in the UI
                    kdbxEntry.uuid = new kdbxweb.KdbxUuid(entry.id);
                }
            }

            // Update entry fields. A standard field the file protected goes
            // back protected: the model carries the text, protectedFields
            // carries the flag it arrived with
            // An entry read out of the file says what it protects. One created
            // in the UI says nothing, and takes the database's defaults
            const protectedNames = entry.protectedFields
                ? new Set(entry.protectedFields)
                : KeepassDatabaseService.defaultProtectedFields(kdbxDb);
            const standard = (name: string, text: string): string | kdbxweb.ProtectedValue =>
                protectedNames.has(name) ? kdbxweb.ProtectedValue.fromString(text) : text;

            kdbxEntry.fields.set('Title', standard('Title', entry.title));
            kdbxEntry.fields.set('UserName', standard('UserName', entry.username));
            kdbxEntry.fields.set('Password', typeof entry.password === 'string'
                ? kdbxweb.ProtectedValue.fromString(entry.password)
                : entry.password
            );
            if (entry.url) kdbxEntry.fields.set('URL', standard('URL', entry.url));
            else kdbxEntry.fields.delete('URL');
            if (entry.notes) kdbxEntry.fields.set('Notes', standard('Notes', entry.notes));
            else kdbxEntry.fields.delete('Notes');

            // Sync custom fields: drop the ones removed in the UI, write the rest
            const modelKeys = new Set((entry.customFields ?? []).map(f => f.key));
            for (const key of [...kdbxEntry.fields.keys()]) {
                if (!this.STANDARD_FIELDS.includes(key) && !modelKeys.has(key)) {
                    kdbxEntry.fields.delete(key);
                }
            }
            for (const field of entry.customFields ?? []) {
                kdbxEntry.fields.set(field.key, field.protected
                    ? (typeof field.value === 'string' ? kdbxweb.ProtectedValue.fromString(field.value) : field.value)
                    : this.getFieldString(field.value)
                );
            }
            kdbxEntry.tags = this.normalizeTags(entry.tags ?? []);
            kdbxEntry.times.creationTime = entry.created;
            kdbxEntry.times.lastModTime = entry.modified;
            kdbxEntry.times.expires = !!entry.expires;
            kdbxEntry.times.expiryTime = entry.expiryTime;

            // Sync attachments: registering through createBinary puts the data in
            // the database binary pool and dedupes identical content by hash
            kdbxEntry.binaries.clear();
            for (const attachment of entry.attachments ?? []) {
                kdbxEntry.binaries.set(attachment.name, await kdbxDb.createBinary(attachment.data));
            }

            updatedEntries.push(kdbxEntry);
        }

        // Replace all entries at once
        kdbxGroup.entries = updatedEntries;

        // Process all groups in one pass
        const updatedGroups: kdbxweb.KdbxGroup[] = [];
        for (const subgroup of group.groups) {
            let kdbxSubgroup = subgroup.id ? index.groups.get(subgroup.id) : undefined;
            if (kdbxSubgroup) {
                index.groups.delete(subgroup.id);
                // Reparent rather than recreate: a recreated group would take
                // a fresh UUID, which reads as a delete plus an unrelated
                // insert to any replica merging this file
                this.reparent(kdbxSubgroup, kdbxGroup);
            } else {
                kdbxSubgroup = kdbxDb.createGroup(kdbxGroup, subgroup.name);
                subgroup.id = kdbxSubgroup.uuid.toString();
                if (subgroup.isRecycleBin) {
                    kdbxSubgroup.icon = kdbxweb.Consts.Icons.TrashBin;
                    kdbxDb.meta.recycleBinUuid = kdbxSubgroup.uuid;
                    kdbxDb.meta.recycleBinEnabled = true;
                }
            }
            await this.updateGroup(subgroup, kdbxSubgroup, kdbxDb, index, false, frozen);
            updatedGroups.push(kdbxSubgroup);
        }

        // Replace all groups at once
        kdbxGroup.groups = updatedGroups;
    }

    // A different mtime only means something touched the file. Read it and
    // compare the bytes against what we last wrote before believing the
    // contents actually changed, so a touch alone never triggers a merge or
    // the notice that goes with it
    private static async readIfChanged(filePath: string): Promise<{ changed: boolean; data?: Uint8Array }> {
        const result = await window.electron!.readFile(filePath);
        // Unreadable: assume the worst and let the merge path handle it
        if (!result.success || !result.data) return { changed: true };

        const bytes = new Uint8Array(result.data);
        if (this.lastKnownHash !== undefined && await this.hashBytes(bytes) === this.lastKnownHash) {
            return { changed: false };
        }
        return { changed: true, data: bytes };
    }

    private static async mergeExternalChanges(kdbxDb: kdbxweb.Kdbx, data: Uint8Array | undefined): Promise<boolean> {
        if (!data) return false;

        let before: Set<string> | undefined;
        try {
            const remoteDb = await kdbxweb.Kdbx.load(
                data.slice().buffer,
                kdbxDb.credentials
            );

            // Before the merge, not after: these notes are what it reads to
            // decide whether a revision missing from the incoming file was
            // deleted there or simply never seen. The incoming file's own
            // notes count too, and are only reachable here, because the merge
            // that would copy them across has not run yet
            HistoryNotesService.apply(
                kdbxDb,
                HistoryNotesService.read(kdbxDb),
                HistoryNotesService.read(remoteDb)
            );

            before = this.collectUuids(kdbxDb.getDefaultGroup());
            kdbxDb.merge(remoteDb);

            (window as any).showToast?.({
                message: 'The database changed on disk; external changes were merged',
                type: 'info'
            });
            return true;
        } catch (err) {
            console.error('Failed to merge external changes:', err);
            return false;
        } finally {
            // In the finally, not the success path: a merge that throws
            // part-way has still grafted objects into the live kdbx, and
            // leaving them unregistered would let the next save tombstone
            // them, deleting them on the machine that made them
            if (before) {
                for (const uuid of this.collectUuids(kdbxDb.getDefaultGroup())) {
                    if (!before.has(uuid) && !this.unseenUuids.has(uuid)) {
                        this.unseenUuids.set(uuid, undefined);
                    }
                }
            }
        }
    }

    // A vault just opened carries the notes every replica that touched it
    // recorded; hand them to kdbxweb so its merge can read them. Without this
    // the notes would only ever cover the current session, which is the window
    // in which they are least needed
    static restoreHistoryNotes(kdbxDb: kdbxweb.Kdbx): void {
        HistoryNotesService.apply(kdbxDb, HistoryNotesService.read(kdbxDb));
    }

    // The merge settles entry history from notes saying which revisions a
    // replica recorded: pushHistory writes one, and the merge reads them to
    // tell "somebody added this" apart from "the other side deleted it".
    // kdbxweb keeps a deleted list too, and drops the lot once the state has
    // been written. This does neither, for reasons that are all the same
    // reason: a kdbx file in a synced folder has no central upstream, so a
    // replica writing over the top has not necessarily read what it replaces.
    //
    // The added notes are kept and written into the file (HistoryNotesService),
    // less the ones that can no longer say anything. The merge only ever asks
    // about revisions an entry still holds, so a note for a revision retention
    // has since dropped is dead weight. That bounds the list by the retention
    // limit instead of letting it grow once per save for the life of the
    // session, which matters both for what goes in the file and because the
    // merge scans the list linearly for every revision it looks at.
    //
    // The deleted notes go entirely. Their only job is to stop a revision this
    // replica trimmed coming back from someone who still has it, and the
    // retention pass runs on every save, so anything a merge re-adds is
    // trimmed again before the file is written. Keeping them would buy nothing
    // and cost the one thing they can do wrong: refuse a revision back
    // permanently, on a timestamp match, whoever offers it
    private static pruneLocalEditState(kdbxDb: kdbxweb.Kdbx): void {
        for (const entry of kdbxDb.getDefaultGroup().allEntries()) {
            const editState = entry._editState;
            if (!editState) continue;

            const live = new Set<number>();
            for (const revision of entry.history) {
                const time = revision.times.lastModTime?.getTime();
                if (time !== undefined) live.add(time);
            }

            const added = editState.added.filter(time => live.has(time));
            entry._editState = added.length > 0 ? { added, deleted: [] } : undefined;
        }
    }

    // Saves run one at a time. A save is a long sequence of awaits that mutates
    // kdbxDb throughout (updateGroup replaces whole entry and group lists,
    // cleanup prunes the binary pool) and moves the conflict-detection
    // baseline, so a second one starting in the middle of the first would be
    // reading half-applied state. They overlap easily: the UI saves on every
    // edit, and browser integration calls this from an IPC handler whenever
    // the extension writes a login or registers a passkey.
    //
    // Requests arriving while one is in flight collapse into a single
    // follow-up rather than queueing one write each: a save serializes the
    // whole in-memory state, so the newest request's state covers every
    // request before it. Dragging five entries costs two full
    // serialize-encrypt-write cycles, not five
    private static saveInFlight = false;
    private static queuedSave: {
        database: Database;
        kdbxDb: kdbxweb.Kdbx;
        result: Promise<void>;
        resolve: () => void;
        reject: (err: unknown) => void;
    } | null = null;

    static saveDatabase(database: Database, kdbxDb: kdbxweb.Kdbx): Promise<void> {
        if (!this.saveInFlight) {
            return this.runSave(database, kdbxDb);
        }
        if (this.queuedSave) {
            // The waiting save has not started, so pointing it at the newer
            // state serves its earlier callers too
            this.queuedSave.database = database;
            this.queuedSave.kdbxDb = kdbxDb;
            return this.queuedSave.result;
        }
        let resolve!: () => void;
        let reject!: (err: unknown) => void;
        const result = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        this.queuedSave = { database, kdbxDb, result, resolve, reject };
        return result;
    }

    private static async runSave(database: Database, kdbxDb: kdbxweb.Kdbx): Promise<void> {
        this.saveInFlight = true;
        try {
            return await this.performSave(database, kdbxDb);
        } finally {
            this.saveInFlight = false;
            const queued = this.queuedSave;
            if (queued) {
                this.queuedSave = null;
                this.runSave(queued.database, queued.kdbxDb).then(queued.resolve, queued.reject);
            }
        }
    }

    private static async performSave(database: Database, kdbxDb: kdbxweb.Kdbx): Promise<void> {
        try {
            if (!kdbxDb) {
                throw new Error('Database not loaded');
            }

            kdbxDb.meta.name = database.name;

            const root = kdbxDb.getDefaultGroup();
            if (root) {
                const collectUuids = (group: kdbxweb.KdbxGroup, into: Set<string>) => {
                    into.add(group.uuid.toString());
                    group.entries.forEach(e => into.add(e.uuid.toString()));
                    group.groups.forEach(g => collectUuids(g, into));
                };

                const uuidsBefore = new Set<string>();
                collectUuids(root, uuidsBefore);

                // Protect objects this model is not entitled to delete: ones
                // no model has been built from yet, and ones first carried by
                // a model newer than the one being applied
                const modelGeneration = database.generation ?? 0;
                const unseen = new Set<string>();
                for (const [uuid, seenAt] of this.unseenUuids) {
                    if (seenAt === undefined || modelGeneration < seenAt) unseen.add(uuid);
                }
                // Entries whose values this model is too old to overwrite
                const frozen = new Set<string>();
                for (const [uuid, seenAt] of this.unmodeledEditUuids) {
                    if (seenAt === undefined || modelGeneration < seenAt) frozen.add(uuid);
                    // An up-to-date model is authoritative again; the entry
                    // closes out of the ledger
                    else this.unmodeledEditUuids.delete(uuid);
                }
                const index = this.indexDatabase(root);
                await this.updateGroup(database.root, root, kdbxDb, index, true, frozen);
                this.keepUnseenMerged(root, index, unseen);

                // Record permanently deleted objects so a later merge (another
                // machine editing the same file) deletes them instead of
                // resurrecting them
                const uuidsAfter = new Set<string>();
                collectUuids(root, uuidsAfter);
                for (const uuid of uuidsBefore) {
                    if (!uuidsAfter.has(uuid)) {
                        const deleted = new kdbxweb.KdbxDeletedObject();
                        deleted.uuid = new kdbxweb.KdbxUuid(uuid);
                        deleted.deletionTime = new Date();
                        kdbxDb.deletedObjects.push(deleted);
                        // A deletion the user chose closes the ledger entry
                        this.unseenUuids.delete(uuid);
                    }
                }
            }

            // The file changed on disk since we read or wrote it (another
            // machine, a sync client): merge instead of clobbering
            // Whether this save is about to replace a version of the file
            // Vigil did not write, which decides whether the backup below can
            // be skipped for being too recent
            let replacingExternalChanges = false;
            const pathBeforeSave = this.getPath();
            // Either half of the baseline is enough to check with; requiring
            // the mtime alone meant a single failed stat at open silently
            // disabled conflict detection for every save until the first one
            // landed and refreshed it
            if (pathBeforeSave && window.electron &&
                (this.lastKnownMtimeMs !== undefined || this.lastKnownHash !== undefined)) {
                const stat = await window.electron.statFile(pathBeforeSave);
                // mtime is the cheap filter; the bytes are what decide. With
                // no mtime baseline the filter cannot clear anything, so any
                // stat result sends the save on to the byte comparison
                const touched = stat.success && stat.mtimeMs !== undefined &&
                    (this.lastKnownMtimeMs === undefined || stat.mtimeMs !== this.lastKnownMtimeMs);
                const external = touched ? await this.readIfChanged(pathBeforeSave) : { changed: false };
                if (touched && !external.changed) {
                    // Same bytes under a new timestamp: nothing to merge, just
                    // stop re-reading the file on every save from here on
                    this.lastKnownMtimeMs = stat.mtimeMs;
                }
                if (external.changed) {
                    // True whether the merge succeeds or the user overwrites:
                    // either way the version on disk is about to be gone
                    replacingExternalChanges = true;
                    const merged = await this.mergeExternalChanges(kdbxDb, external.data);
                    if (!merged) {
                        // Asked through the resolver App registers, never
                        // window.confirm: a synchronous prompt blocked the
                        // renderer with the save queue behind it, was
                        // invisible to headless callers (browser IPC,
                        // import), and Chromium answers it false during
                        // unload, silently discarding the edit. With nobody
                        // to ask, the safe answer is no
                        const overwrite = this.conflictResolver
                            ? await this.conflictResolver(
                                'The database file was modified outside Vigil and the changes could not be merged. Overwrite them with your version?'
                            )
                            : false;
                        if (!overwrite) {
                            throw new Error('SAVE_CANCELLED_CONFLICT');
                        }
                    }
                }
            }

            // Enforce the file's history retention rules and drop binaries no
            // longer referenced by any entry or history revision
            kdbxDb.cleanup({ historyRules: true, binaries: true });

            // After the retention trim, so notes for revisions it just dropped
            // are not carried, and before the save, because these go into the
            // bytes it produces
            this.pruneLocalEditState(kdbxDb);
            HistoryNotesService.purgeEmpty(kdbxDb);
            HistoryNotesService.write(kdbxDb, userSettingsService.getReplicaId());

            // Save the updated database
            const arrayBuffer = await kdbxDb.save();

            let result: SaveResult | undefined;
            // Copies kept before the file is overwritten; see electron/src/backups.ts
            const backup = { ...userSettingsService.getBackupOptions(), replacingExternalChanges };
            const currentPath = this.getPath();
            if (currentPath) {
                result = await window.electron?.saveToFile(currentPath, new Uint8Array(arrayBuffer), backup);
                if (!result?.success) {
                    // One retry after a beat: sync clients and virus scanners
                    // hold the file briefly and let go. This used to fall
                    // back to a save dialog, which repointed the session's
                    // vault at whatever path was picked under pressure and
                    // left the original file behind, silently forked
                    await new Promise(resolve => setTimeout(resolve, 300));
                    result = await window.electron?.saveToFile(currentPath, new Uint8Array(arrayBuffer), backup);
                }
            } else {
                // No path yet (a newly created database): the dialog is the
                // only way to get one
                result = await window.electron?.saveFile(new Uint8Array(arrayBuffer), backup);
                if (result?.success && result.filePath) {
                    this.setPath(result.filePath, new Uint8Array(arrayBuffer));
                }
            }

            if (!result?.success) {
                throw new Error(result?.error || 'Failed to save database');
            }

            // The format gives no change date of its own to history retention,
            // colour or the key change interval, so a merge settles those from
            // an in-memory note alone: whoever holds one keeps their value.
            // Unlike the entry notes there is no history riding on this, so
            // holding it past the write only pins the field to this session
            // and makes a change from another machine unreachable. Cleared
            // here rather than before the save because a save that failed
            // published nothing, and the local value still has to win
            kdbxDb.meta.editState = undefined;

            // Refresh the conflict-detection baseline to the file we just
            // wrote. The hash comes from the bytes rather than from re-reading
            // the file, so it is exactly what landed
            this.lastKnownHash = await this.hashBytes(new Uint8Array(arrayBuffer));
            const savedPath = this.getPath();
            if (savedPath && window.electron) {
                const stat = await window.electron.statFile(savedPath);
                if (stat.success) {
                    this.lastKnownMtimeMs = stat.mtimeMs;
                }
            }

            // Show success toast
            (window as any).showToast?.({
                message: 'Database saved successfully',
                type: 'success'
            });
        } catch (err) {
            if (err instanceof Error && err.message === 'SAVE_CANCELLED_CONFLICT') {
                (window as any).showToast?.({
                    message: 'Save cancelled; the database on disk was left untouched',
                    type: 'info'
                });
                throw err;
            }
            console.error('Failed to save database:', err);
            // The toast names the underlying error: a save that failed twice
            // is worth more than a generic apology, and there is no log to
            // find it in later
            const detail = err instanceof Error && err.message && err.message !== 'Failed to save database'
                ? `: ${err.message}` : '';
            (window as any).showToast?.({
                message: `Failed to save database${detail}`,
                type: 'error'
            });
            throw err;
        }
    }

    // ---- Database settings ----

    static async verifyMasterPassword(kdbxDb: kdbxweb.Kdbx, password: string): Promise<boolean> {
        const expected = kdbxDb.credentials.passwordHash?.getBinary();
        if (!expected) return password.length === 0;

        const bytes = kdbxweb.ByteUtils.stringToBytes(password);
        const hashBuf = await kdbxweb.CryptoEngine.sha256(kdbxweb.ByteUtils.arrayToBuffer(bytes));
        const actual = new Uint8Array(hashBuf);
        if (actual.length !== expected.length) return false;

        let diff = 0;
        for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
        return diff === 0;
    }

    static async changeMasterPassword(kdbxDb: kdbxweb.Kdbx, newPassword: string): Promise<void> {
        await kdbxDb.credentials.setPassword(kdbxweb.ProtectedValue.fromString(newPassword));
    }

    static getKdfInfo(kdbxDb: kdbxweb.Kdbx): KdfInfo {
        if (kdbxDb.header.versionMajor < 4) {
            return { type: 'aes-kdbx3', iterations: Number(kdbxDb.header.keyEncryptionRounds ?? 0) };
        }

        const params = kdbxDb.header.kdfParameters!;
        const uuid = kdbxweb.ByteUtils.bytesToBase64(new Uint8Array(params.get('$UUID') as ArrayBuffer));
        if (uuid === kdbxweb.Consts.KdfId.Aes) {
            return { type: 'aes', iterations: Number((params.get('R') as kdbxweb.Int64).value) };
        }

        return {
            type: uuid === kdbxweb.Consts.KdfId.Argon2id ? 'argon2id' : 'argon2d',
            iterations: Number((params.get('I') as kdbxweb.Int64).value),
            memoryMiB: Math.round(Number((params.get('M') as kdbxweb.Int64).value) / (1024 * 1024)),
            parallelism: Number(params.get('P')),
        };
    }

    // The most key derivation work an unlock will do, as memory in MiB times
    // iterations: the main process refuses a header past this (MAX_WORK_KIB_PASSES
    // in electron/src/crypto.ts, same value in KiB) so a hostile file cannot
    // hang the app, and the settings UI refuses to write one past it so a
    // vault Vigil made always opens in Vigil. Keep the two in step
    static readonly ARGON2_MAX_WORK_MIB_PASSES = 64 * 1024;

    static argon2WorkExceeded(info: KdfInfo): boolean {
        if (info.type !== 'argon2d' && info.type !== 'argon2id') return false;
        return (info.memoryMiB ?? 64) * info.iterations > this.ARGON2_MAX_WORK_MIB_PASSES;
    }

    static setKdf(kdbxDb: kdbxweb.Kdbx, info: KdfInfo): void {
        if (this.argon2WorkExceeded(info)) {
            throw new Error('KDF_WORK_EXCEEDED');
        }
        if (kdbxDb.header.versionMajor < 4) {
            kdbxDb.header.keyEncryptionRounds = info.iterations;
            return;
        }

        const current = this.getKdfInfo(kdbxDb);
        if (info.type !== current.type && (info.type === 'argon2d' || info.type === 'argon2id')) {
            // Resets parameters and generates a fresh salt
            kdbxDb.header.setKdf(info.type === 'argon2id' ? kdbxweb.Consts.KdfId.Argon2id : kdbxweb.Consts.KdfId.Argon2);
        }

        const params = kdbxDb.header.kdfParameters!;
        const VT = kdbxweb.VarDictionary.ValueType;
        if (info.type === 'aes') {
            params.set('R', VT.UInt64, kdbxweb.Int64.from(info.iterations));
            return;
        }
        params.set('I', VT.UInt64, kdbxweb.Int64.from(info.iterations));
        params.set('M', VT.UInt64, kdbxweb.Int64.from((info.memoryMiB ?? 64) * 1024 * 1024));
        params.set('P', VT.UInt32, info.parallelism ?? 1);
    }

    static getHistoryMaxItems(kdbxDb: kdbxweb.Kdbx): number {
        return kdbxDb.meta.historyMaxItems ?? 10;
    }

    static setHistoryMaxItems(kdbxDb: kdbxweb.Kdbx, maxItems: number): void {
        kdbxDb.meta.historyMaxItems = maxItems;
    }
}

import * as kdbxweb from 'kdbxweb';
import { Database, Group, Entry, EntryVersion, Attachment, CustomField } from '../types/database';

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

export class KeepassDatabaseService {
    // Fields with dedicated UI; everything else on a kdbx entry is a custom field
    static readonly STANDARD_FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

    private static currentPath: string | undefined;
    // mtime of the database file when we last read or wrote it; used to
    // detect edits made outside Vigil before overwriting the file
    private static lastKnownMtimeMs: number | undefined;

    static setPath(path: string | undefined) {
        this.currentPath = path;
        this.lastKnownMtimeMs = undefined;
        if (path && window.electron) {
            window.electron.statFile(path).then(stat => {
                if (stat.success && this.currentPath === path) {
                    this.lastKnownMtimeMs = stat.mtimeMs;
                }
            }).catch(() => {});
        }
    }

    static getPath(): string | undefined {
        return this.currentPath;
    }

    static convertKdbxToDatabase(kdbxDb: kdbxweb.Kdbx): Database {
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
            title: entry.fields.get('Title')?.toString() || '',
            username: entry.fields.get('UserName')?.toString() || '',
            password: entry.fields.get('Password') || '',
            url: entry.fields.get('URL')?.toString(),
            notes: entry.fields.get('Notes')?.toString(),
            modified: entry.times.lastModTime as Date,
            attachments: convertAttachments(entry),
            expires: !!entry.times.expires,
            expiryTime: entry.times.expiryTime as Date | undefined,
            customFields: convertCustomFields(entry),
        });

        const recycleBinId = kdbxDb.meta.recycleBinUuid?.toString();

        const convertGroup = (group: kdbxweb.KdbxGroup): Group => {
            return {
                id: group.uuid.toString(),
                isRecycleBin: !!recycleBinId && group.uuid.toString() === recycleBinId,
                name: group.name as string,
                groups: group.groups.map(g => convertGroup(g)),
                entries: group.entries.map(entry => ({
                    ...convertVersion(entry),
                    id: entry.uuid.toString(),
                    created: entry.times.creationTime as Date,
                    history: entry.history.map(convertVersion),
                })),
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
        };
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

    static filterEntries(entries: Entry[], searchQuery: string): Entry[] {
        if (!searchQuery) return entries;

        const searchTerms = searchQuery.toLowerCase().split(' ').filter(Boolean);
        if (searchTerms.length === 0) return entries;

        return entries.filter(entry => {
            const searchableText = [
                entry.title,
                entry.username,
                entry.url,
                entry.notes
            ].filter(Boolean).join(' ').toLowerCase();

            return searchTerms.every(term => searchableText.includes(term));
        });
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
        const findGroupContainingEntry = (group: Group): Group | null => {
            if (group.entries.some(e => e.id === entry.id)) {
                return group;
            }
            for (const subgroup of group.groups) {
                const found = findGroupContainingEntry(subgroup);
                if (found) return found;
            }
            return null;
        };

        const updatedDatabase: Database = this.deepCopyWithDates(database);
        let savedEntry = entry;

        if (isCreatingNew) {
            // Assign the entry its definitive kdbx UUID up front so later
            // edits and saves address the same entry
            savedEntry = { ...entry, id: kdbxweb.KdbxUuid.random().toString() };
            const updatedGroup = this.findGroupInDatabase(selectedGroup.id, updatedDatabase.root) || updatedDatabase.root;
            updatedGroup.entries.push(savedEntry);
        } else {
            const group = findGroupContainingEntry(updatedDatabase.root);
            if (group) {
                const entryIndex = group.entries.findIndex(e => e.id === entry.id);
                if (entryIndex !== -1) {
                    group.entries[entryIndex] = entry;
                }
            }
        }

        return [updatedDatabase, savedEntry];
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
        const field = (name: string) => kdbxEntry.fields.get(name)?.toString() ?? '';
        if (field('Title') !== entry.title) return true;
        if (field('UserName') !== entry.username) return true;
        if (field('URL') !== (entry.url ?? '')) return true;
        if (field('Notes') !== (entry.notes ?? '')) return true;

        const existingPassword = kdbxEntry.fields.get('Password');
        const oldPassword = existingPassword ? this.getPasswordString(existingPassword as string | kdbxweb.ProtectedValue) : '';
        if (oldPassword !== this.getPasswordString(entry.password)) return true;

        if (!!kdbxEntry.times.expires !== !!entry.expires) return true;
        if ((kdbxEntry.times.expiryTime?.getTime() ?? 0) !== (entry.expiryTime?.getTime() ?? 0)) return true;

        if (this.customFieldsChanged(kdbxEntry, entry.customFields ?? [])) return true;

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
            if (this.getFieldString(value) !== this.getFieldString(field.value)) return true;
        }

        return false;
    }

    private static async updateGroup(group: Group, kdbxGroup: kdbxweb.KdbxGroup, kdbxDb: kdbxweb.Kdbx, isRoot = false): Promise<void> {
        // The UI labels the root group "All Entries"; never write that label
        // over the real group name stored in the file
        if (!isRoot) {
            kdbxGroup.name = group.name;
        }

        // Create a map of existing entries for faster lookup
        const existingEntries = new Map(
            kdbxGroup.entries.map(entry => [entry.uuid.toString(), entry])
        );

        // Process all entries in one pass
        const updatedEntries: kdbxweb.KdbxEntry[] = [];
        for (const entry of group.entries) {
            let kdbxEntry = entry.id ? existingEntries.get(entry.id) : undefined;
            if (kdbxEntry) {
                // Snapshot the previous revision, but only when the entry really
                // changed: every save rewrites every entry, and unconditional
                // pushes would bloat the file with identical revisions
                if (this.entryChanged(kdbxEntry, entry)) {
                    kdbxEntry.pushHistory();
                }
            } else {
                kdbxEntry = kdbxDb.createEntry(kdbxGroup);
                if (entry.id) {
                    // Keep the UUID assigned when the entry was created in the UI
                    kdbxEntry.uuid = new kdbxweb.KdbxUuid(entry.id);
                }
            }

            // Update entry fields
            kdbxEntry.fields.set('Title', entry.title);
            kdbxEntry.fields.set('UserName', entry.username);
            kdbxEntry.fields.set('Password', typeof entry.password === 'string'
                ? kdbxweb.ProtectedValue.fromString(entry.password)
                : entry.password
            );
            if (entry.url) kdbxEntry.fields.set('URL', entry.url);
            else kdbxEntry.fields.delete('URL');
            if (entry.notes) kdbxEntry.fields.set('Notes', entry.notes);
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

        // Create a map of existing groups for faster lookup
        const existingGroups = new Map(
            kdbxGroup.groups.map(g => [g.uuid.toString(), g])
        );

        // Process all groups in one pass
        const updatedGroups: kdbxweb.KdbxGroup[] = [];
        for (const subgroup of group.groups) {
            let kdbxSubgroup = existingGroups.get(subgroup.id);
            if (!kdbxSubgroup) {
                kdbxSubgroup = kdbxDb.createGroup(kdbxGroup, subgroup.name);
                subgroup.id = kdbxSubgroup.uuid.toString();
                if (subgroup.isRecycleBin) {
                    kdbxSubgroup.icon = kdbxweb.Consts.Icons.TrashBin;
                    kdbxDb.meta.recycleBinUuid = kdbxSubgroup.uuid;
                    kdbxDb.meta.recycleBinEnabled = true;
                }
            }
            await this.updateGroup(subgroup, kdbxSubgroup, kdbxDb);
            updatedGroups.push(kdbxSubgroup);
        }

        // Replace all groups at once
        kdbxGroup.groups = updatedGroups;
    }

    private static async mergeExternalChanges(filePath: string, kdbxDb: kdbxweb.Kdbx): Promise<boolean> {
        try {
            const result = await window.electron!.readFile(filePath);
            if (!result.success || !result.data) return false;

            const remoteDb = await kdbxweb.Kdbx.load(
                new Uint8Array(result.data).buffer,
                kdbxDb.credentials
            );
            kdbxDb.merge(remoteDb);

            (window as any).showToast?.({
                message: 'The database changed on disk; external changes were merged',
                type: 'info'
            });
            return true;
        } catch (err) {
            console.error('Failed to merge external changes:', err);
            return false;
        }
    }

    static async saveDatabase(database: Database, kdbxDb: kdbxweb.Kdbx): Promise<void> {
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

                await this.updateGroup(database.root, root, kdbxDb, true);

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
                    }
                }
            }

            // The file changed on disk since we read or wrote it (another
            // machine, a sync client): merge instead of clobbering
            const pathBeforeSave = this.getPath();
            if (pathBeforeSave && window.electron && this.lastKnownMtimeMs !== undefined) {
                const stat = await window.electron.statFile(pathBeforeSave);
                if (stat.success && stat.mtimeMs !== undefined && stat.mtimeMs !== this.lastKnownMtimeMs) {
                    const merged = await this.mergeExternalChanges(pathBeforeSave, kdbxDb);
                    if (!merged) {
                        const overwrite = window.confirm(
                            'The database file was modified outside Vigil and the changes could not be merged. Overwrite them with your version?'
                        );
                        if (!overwrite) {
                            throw new Error('SAVE_CANCELLED_CONFLICT');
                        }
                    }
                }
            }

            // Enforce the file's history retention rules and drop binaries no
            // longer referenced by any entry or history revision
            kdbxDb.cleanup({ historyRules: true, binaries: true });

            // Save the updated database
            const arrayBuffer = await kdbxDb.save();

            let result: SaveResult | undefined;
            const currentPath = this.getPath();
            if (currentPath) {
                // If we have a path, save directly to it
                result = await window.electron?.saveToFile(currentPath, new Uint8Array(arrayBuffer));
                if (!result?.success) {
                    // If direct save fails, fall back to save dialog
                    result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));
                    if (result?.success && result.filePath) {
                        this.setPath(result.filePath);
                    }
                }
            } else {
                // If no path, use save dialog
                result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));
                if (result?.success && result.filePath) {
                    this.setPath(result.filePath);
                }
            }

            if (!result?.success) {
                throw new Error(result?.error || 'Failed to save database');
            }

            // Refresh the conflict-detection baseline to the file we just wrote
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
            // Show error toast
            (window as any).showToast?.({
                message: 'Failed to save database',
                type: 'error'
            });
            throw err;
        }
    }
}
import * as kdbxweb from 'kdbxweb';
import { Database, Group, Entry } from '../types/database';

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

// Cache interface for memoization
interface Cache<T> {
    value: T;
    timestamp: number;
}

export class KeepassDatabaseService {
    private static readonly CACHE_DURATION = 5000; // 5 seconds cache duration
    private static entriesCache = new Map<string, Cache<Entry[]>>();
    private static groupCache = new Map<string, Cache<Group>>();
    private static currentPath: string | undefined;

    static setPath(path: string | undefined) {
        this.currentPath = path;
    }

    static getPath(): string | undefined {
        return this.currentPath;
    }

    private static clearCache() {
        this.entriesCache.clear();
        this.groupCache.clear();
    }

    private static getCacheKey(group: Group, searchQuery: string = ''): string {
        return `${group.id}_${searchQuery}`;
    }

    private static getFromCache<T>(cache: Map<string, Cache<T>>, key: string): T | null {
        const cached = cache.get(key);
        if (!cached) return null;

        const now = Date.now();
        if (now - cached.timestamp > this.CACHE_DURATION) {
            cache.delete(key);
            return null;
        }

        return cached.value;
    }

    private static setCache<T>(cache: Map<string, Cache<T>>, key: string, value: T) {
        cache.set(key, { value, timestamp: Date.now() });
    }

    static convertKdbxToDatabase(kdbxDb: kdbxweb.Kdbx): Database {
        const convertGroup = (group: kdbxweb.KdbxGroup): Group => {
            return {
                id: group.uuid.toString(),
                name: group.name as string,
                groups: group.groups.map(g => convertGroup(g)),
                entries: group.entries.map(entry => ({
                    id: entry.uuid.toString(),
                    title: entry.fields.get('Title')?.toString() || '',
                    username: entry.fields.get('UserName')?.toString() || '',
                    password: entry.fields.get('Password') || '',
                    url: entry.fields.get('URL')?.toString(),
                    notes: entry.fields.get('Notes')?.toString(),
                    created: entry.times.creationTime as Date,
                    modified: entry.times.lastModTime as Date,
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
        };
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
        const cacheKey = this.getCacheKey(group);
        const cached = this.getFromCache(this.entriesCache, cacheKey);
        if (cached) return cached;

        let entries = [...group.entries];
        group.groups.forEach(subgroup => {
            entries = entries.concat(this.getAllEntriesFromGroup(subgroup));
        });

        this.setCache(this.entriesCache, cacheKey, entries);
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

    static getEntriesForDisplay(group: Group, database: Database | undefined, searchQuery: string): Entry[] {
        const cacheKey = this.getCacheKey(group, searchQuery);
        const cached = this.getFromCache(this.entriesCache, cacheKey);
        if (cached) return cached;

        const baseEntries = group === database?.root || searchQuery
            ? this.getAllEntriesFromGroup(group)
            : this.getAllEntriesFromGroup(group);

        const filteredEntries = this.filterEntries(baseEntries, searchQuery);
        const sortedEntries = this.sortEntriesByTitle(filteredEntries);

        this.setCache(this.entriesCache, cacheKey, sortedEntries);
        return sortedEntries;
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
        const cacheKey = `find_${groupId}`;
        const cached = this.getFromCache(this.groupCache, cacheKey);
        if (cached) return cached;

        if (root.id === groupId) {
            this.setCache(this.groupCache, cacheKey, root);
            return root;
        }

        for (const subgroup of root.groups) {
            const found = this.findGroupInDatabase(groupId, subgroup);
            if (found) {
                this.setCache(this.groupCache, cacheKey, found);
                return found;
            }
        }

        return null;
    }

    static countEntriesInGroup(group: Group): number {
        let count = group.entries.length;
        group.groups.forEach(subgroup => {
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
            expanded: true,
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

        const removeGroupFromParent = (group: Group): boolean => {
            const index = group.groups.findIndex(g => g.id === groupToRemove.id);
            if (index !== -1) {
                group.groups.splice(index, 1);
                return true;
            }
            for (const subgroup of group.groups) {
                if (removeGroupFromParent(subgroup)) return true;
            }
            return false;
        };

        const removedFromRoot = removeGroupFromParent(updatedDatabase.root);

        if (!removedFromRoot) {
            const topLevelIndex = updatedDatabase.groups.findIndex(g => g.id === groupToRemove.id);
            if (topLevelIndex !== -1) {
                updatedDatabase.groups.splice(topLevelIndex, 1);
            }
        }

        updatedDatabase.groups = updatedDatabase.groups.filter((g: Group) => g.id !== groupToRemove.id);
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

    static saveEntry(database: Database, entry: Entry, selectedGroup: Group, isCreatingNew: boolean): Database {
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

        if (isCreatingNew) {
            const updatedGroup = this.findGroupInDatabase(selectedGroup.id, updatedDatabase.root) || updatedDatabase.root;
            updatedGroup.entries.push(entry);
        } else {
            const group = findGroupContainingEntry(updatedDatabase.root);
            if (group) {
                const entryIndex = group.entries.findIndex(e => e.id === entry.id);
                if (entryIndex !== -1) {
                    group.entries[entryIndex] = entry;
                }
            }
        }

        this.clearCache();
        return updatedDatabase;
    }

    static removeEntry(database: Database, entryToRemove: Entry): Database {
        const updatedDatabase: Database = this.deepCopyWithDates(database);
        const removeEntryFromGroup = (group: Group): boolean => {
            const index = group.entries.findIndex(e => e.id === entryToRemove.id);
            if (index !== -1) {
                group.entries.splice(index, 1);
                return true;
            }
            for (const subgroup of group.groups) {
                if (removeEntryFromGroup(subgroup)) return true;
            }
            return false;
        };

        removeEntryFromGroup(updatedDatabase.root);
        this.clearCache();
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

        this.clearCache();
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

    private static updateGroup(group: Group, kdbxGroup: kdbxweb.KdbxGroup, kdbxDb: kdbxweb.Kdbx) {
        // Update group name
        kdbxGroup.name = group.name;

        // Create a map of existing entries for faster lookup
        const existingEntries = new Map(
            kdbxGroup.entries.map(entry => [entry.uuid.toString(), entry])
        );

        // Process all entries in one pass
        const updatedEntries: kdbxweb.KdbxEntry[] = [];
        group.entries.forEach((entry: Entry) => {
            let kdbxEntry: kdbxweb.KdbxEntry;

            if (entry.id && entry.id.length === 32) {
                // Reuse existing entry if available
                kdbxEntry = existingEntries.get(entry.id) || kdbxDb.createEntry(kdbxGroup);
                if (!existingEntries.has(entry.id)) {
                    // Set UUID for new entry
                    const uuidBytes = new Uint8Array(16);
                    for (let i = 0; i < 16; i++) {
                        uuidBytes[i] = parseInt(entry.id.substr(i * 2, 2), 16);
                    }
                    kdbxEntry.uuid = new kdbxweb.KdbxUuid(uuidBytes);
                }
            } else {
                kdbxEntry = kdbxDb.createEntry(kdbxGroup);
            }

            // Update entry fields
            kdbxEntry.fields.set('Title', entry.title);
            kdbxEntry.fields.set('UserName', entry.username);
            kdbxEntry.fields.set('Password', typeof entry.password === 'string'
                ? kdbxweb.ProtectedValue.fromString(entry.password)
                : entry.password
            );
            if (entry.url) kdbxEntry.fields.set('URL', entry.url);
            if (entry.notes) kdbxEntry.fields.set('Notes', entry.notes);
            kdbxEntry.times.creationTime = entry.created;
            kdbxEntry.times.lastModTime = entry.modified;

            updatedEntries.push(kdbxEntry);
        });

        // Replace all entries at once
        kdbxGroup.entries = updatedEntries;

        // Create a map of existing groups for faster lookup
        const existingGroups = new Map(
            kdbxGroup.groups.map(g => [g.uuid.toString(), g])
        );

        // Process all groups in one pass
        const updatedGroups: kdbxweb.KdbxGroup[] = [];
        group.groups.forEach((subgroup: Group) => {
            let kdbxSubgroup = existingGroups.get(subgroup.id);
            if (!kdbxSubgroup) {
                kdbxSubgroup = kdbxDb.createGroup(kdbxGroup, subgroup.name);
                subgroup.id = kdbxSubgroup.uuid.toString();
            }
            this.updateGroup(subgroup, kdbxSubgroup, kdbxDb);
            updatedGroups.push(kdbxSubgroup);
        });

        // Replace all groups at once
        kdbxGroup.groups = updatedGroups;
    }

    static async saveDatabase(database: Database, kdbxDb: kdbxweb.Kdbx): Promise<void> {
        try {
            if (!kdbxDb) {
                throw new Error('Database not loaded');
            }

            const root = kdbxDb.getDefaultGroup();
            if (root) {
                this.updateGroup(database.root, root, kdbxDb);
            }

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

            // Show success toast
            (window as any).showToast?.({
                message: 'Database saved successfully',
                type: 'success'
            });

            this.clearCache();
        } catch (err) {
            console.error('Failed to save database:', err);
            // Show error toast
            (window as any).showToast?.({
                message: 'Failed to save database',
                type: 'error'
            });
            this.clearCache();
            throw err;
        }
    }
}
import * as kdbxweb from 'kdbxweb';
import { Database, Group } from '../types/database';

export const convertKdbxToDatabase = (kdbxDb: kdbxweb.Kdbx): Database => {
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
}; 
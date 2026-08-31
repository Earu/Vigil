import * as kdbxweb from 'kdbxweb';
import { TotpService } from './TotpService';
import { CustomField } from '../types/database';

const STANDARD_FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

export class ExportService {
    // KeePassXC-compatible CSV: same columns, everything quoted, ISO dates
    static readonly CSV_HEADERS = ['Group', 'Title', 'Username', 'Password', 'URL', 'Notes', 'TOTP', 'Icon', 'Last Modified', 'Created'];

    private static quote(value: string): string {
        return '"' + value.replace(/"/g, '""') + '"';
    }

    private static fieldString(value: string | kdbxweb.ProtectedValue | undefined): string {
        if (value === undefined) return '';
        return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
    }

    private static totpUriOf(entry: kdbxweb.KdbxEntry): string {
        const customFields: CustomField[] = [];
        for (const [key, value] of entry.fields) {
            if (STANDARD_FIELDS.includes(key)) continue;
            customFields.push({ key, value, protected: value instanceof kdbxweb.ProtectedValue });
        }
        const config = TotpService.getConfig(customFields);
        if (!config) return '';
        return TotpService.buildOtpAuthUri(config, this.fieldString(entry.fields.get('Title')) || 'Entry');
    }

    static collectRows(kdbxDb: kdbxweb.Kdbx): string[][] {
        const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
        const rows: string[][] = [];

        const walk = (group: kdbxweb.KdbxGroup, path: string) => {
            if (recycleBinUuid && group.uuid.id === recycleBinUuid) return;
            for (const entry of group.entries) {
                rows.push([
                    path,
                    this.fieldString(entry.fields.get('Title')),
                    this.fieldString(entry.fields.get('UserName')),
                    this.fieldString(entry.fields.get('Password')),
                    this.fieldString(entry.fields.get('URL')),
                    this.fieldString(entry.fields.get('Notes')),
                    this.totpUriOf(entry),
                    String(entry.icon ?? 0),
                    entry.times.lastModTime?.toISOString() ?? '',
                    entry.times.creationTime?.toISOString() ?? '',
                ]);
            }
            for (const child of group.groups) {
                walk(child, `${path}/${child.name ?? ''}`);
            }
        };

        const root = kdbxDb.getDefaultGroup();
        walk(root, String(root.name ?? 'Root'));
        return rows;
    }

    static entryCount(kdbxDb: kdbxweb.Kdbx): number {
        return this.collectRows(kdbxDb).length;
    }

    static toCsv(kdbxDb: kdbxweb.Kdbx): string {
        const lines = [this.CSV_HEADERS, ...this.collectRows(kdbxDb)]
            .map(row => row.map(field => this.quote(field)).join(','));
        return lines.join('\r\n') + '\r\n';
    }

    static exportFileName(kdbxDb: kdbxweb.Kdbx): string {
        const name = (kdbxDb.meta.name || 'vigil').replace(/[^\w.-]+/g, '_');
        return `${name}-export.csv`;
    }
}

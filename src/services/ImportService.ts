import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { TotpService } from './TotpService';

export interface ImportedEntry {
    title: string;
    username: string;
    password: string;
    url?: string;
    notes?: string;
    totp?: string; // otpauth URI or bare base32 secret
    group?: string[]; // folder path, outermost first
    customFields?: Array<{ key: string; value: string; protected: boolean }>;
}

export interface ImportResult {
    source: 'Bitwarden' | 'LastPass' | '1Password' | 'CSV';
    entries: ImportedEntry[];
    skipped: number; // items of unsupported types (cards, identities, ...)
}

export class ImportService {
    // RFC 4180 tokenizer: quoted fields may contain commas, escaped quotes
    // and newlines (LastPass notes regularly span lines)
    static parseCsv(text: string): string[][] {
        const rows: string[][] = [];
        let row: string[] = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (inQuotes) {
                if (char === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += char;
                }
            } else if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                row.push(field);
                field = '';
            } else if (char === '\n' || char === '\r') {
                if (char === '\r' && text[i + 1] === '\n') i++;
                row.push(field);
                field = '';
                if (row.some(value => value.length > 0)) rows.push(row);
                row = [];
            } else {
                field += char;
            }
        }
        row.push(field);
        if (row.some(value => value.length > 0)) rows.push(row);
        return rows;
    }

    static async parseFile(file: File): Promise<ImportResult> {
        const text = (await file.text()).replace(/^﻿/, '');
        const trimmed = text.trim();

        if (trimmed.startsWith('{') || file.name.toLowerCase().endsWith('.json')) {
            return this.parseBitwardenJson(trimmed);
        }

        const rows = this.parseCsv(text);
        if (rows.length < 2) {
            throw new Error('The file contains no entries');
        }

        const headers = rows[0].map(h => h.trim().toLowerCase());
        const has = (...names: string[]) => names.every(n => headers.includes(n));

        if (has('login_username', 'login_password')) {
            return this.parseBitwardenCsv(headers, rows.slice(1));
        }
        if (has('url', 'username', 'password', 'extra', 'grouping')) {
            return this.parseLastPassCsv(headers, rows.slice(1));
        }
        if (has('title', 'username', 'password') && (headers.includes('otpauth') || headers.includes('archived'))) {
            return this.parseOnePasswordCsv(headers, rows.slice(1));
        }
        return this.parseGenericCsv(headers, rows.slice(1));
    }

    // ---- Bitwarden ----

    private static parseBitwardenJson(text: string): ImportResult {
        let data: any;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('The file is not valid JSON');
        }
        if (data.encrypted === true) {
            throw new Error('This is an encrypted Bitwarden export; export it unencrypted (.json) instead');
        }
        if (!Array.isArray(data.items)) {
            throw new Error('Unrecognized JSON format; expected a Bitwarden export');
        }

        const folderNames = new Map<string, string>(
            (data.folders ?? []).map((f: any) => [f.id, f.name as string])
        );

        const entries: ImportedEntry[] = [];
        let skipped = 0;
        for (const item of data.items) {
            // 1 = login, 2 = secure note; cards and identities are skipped
            if (item.type !== 1 && item.type !== 2) {
                skipped++;
                continue;
            }

            const folder = item.folderId ? folderNames.get(item.folderId) : undefined;
            const customFields = (item.fields ?? [])
                .filter((f: any) => f.name && f.type !== 3) // 3 = linked field
                .map((f: any) => ({
                    key: String(f.name),
                    value: String(f.value ?? ''),
                    protected: f.type === 1, // hidden
                }));

            entries.push({
                title: item.name ?? 'Untitled',
                username: item.login?.username ?? '',
                password: item.login?.password ?? '',
                url: item.login?.uris?.[0]?.uri,
                notes: item.notes ?? undefined,
                totp: item.login?.totp ?? undefined,
                group: folder ? folder.split('/') : undefined,
                customFields: customFields.length ? customFields : undefined,
            });
        }

        return { source: 'Bitwarden', entries, skipped };
    }

    private static parseBitwardenCsv(headers: string[], rows: string[][]): ImportResult {
        const col = (name: string) => headers.indexOf(name);
        const get = (row: string[], name: string) => {
            const index = col(name);
            return index === -1 ? '' : (row[index] ?? '');
        };

        const entries: ImportedEntry[] = [];
        let skipped = 0;
        for (const row of rows) {
            const type = get(row, 'type');
            if (type && type !== 'login' && type !== 'note') {
                skipped++;
                continue;
            }
            const folder = get(row, 'folder');
            entries.push({
                title: get(row, 'name') || 'Untitled',
                username: get(row, 'login_username'),
                password: get(row, 'login_password'),
                url: get(row, 'login_uri') || undefined,
                notes: get(row, 'notes') || undefined,
                totp: get(row, 'login_totp') || undefined,
                group: folder ? folder.split('/') : undefined,
            });
        }
        return { source: 'Bitwarden', entries, skipped };
    }

    // ---- LastPass ----

    private static parseLastPassCsv(headers: string[], rows: string[][]): ImportResult {
        const col = (name: string) => headers.indexOf(name);
        const get = (row: string[], name: string) => {
            const index = col(name);
            return index === -1 ? '' : (row[index] ?? '');
        };

        const entries: ImportedEntry[] = [];
        for (const row of rows) {
            const url = get(row, 'url');
            const grouping = get(row, 'grouping');
            const isSecureNote = url === 'http://sn';
            entries.push({
                title: get(row, 'name') || 'Untitled',
                username: get(row, 'username'),
                password: get(row, 'password'),
                url: isSecureNote || !url ? undefined : url,
                notes: get(row, 'extra') || undefined,
                totp: get(row, 'totp') || undefined,
                // LastPass nests folders with backslashes
                group: grouping ? grouping.split('\\') : undefined,
            });
        }
        return { source: 'LastPass', entries, skipped: 0 };
    }

    // ---- 1Password (CSV export) ----

    private static parseOnePasswordCsv(headers: string[], rows: string[][]): ImportResult {
        const col = (name: string) => headers.indexOf(name);
        const get = (row: string[], name: string) => {
            const index = col(name);
            return index === -1 ? '' : (row[index] ?? '');
        };

        const entries: ImportedEntry[] = [];
        for (const row of rows) {
            entries.push({
                title: get(row, 'title') || 'Untitled',
                username: get(row, 'username'),
                password: get(row, 'password'),
                url: get(row, 'url') || undefined,
                notes: get(row, 'notes') || undefined,
                totp: get(row, 'otpauth') || undefined,
            });
        }
        return { source: '1Password', entries, skipped: 0 };
    }

    // ---- Generic browser CSV (Chrome, Firefox, Edge, Safari) ----

    private static parseGenericCsv(headers: string[], rows: string[][]): ImportResult {
        const find = (...names: string[]) => headers.findIndex(h => names.includes(h));
        const urlIndex = find('url', 'origin', 'web site', 'website');
        const usernameIndex = find('username', 'login', 'usernamevalue', 'username field');
        const passwordIndex = find('password', 'passwordvalue', 'password field');
        const titleIndex = find('name', 'title');
        const notesIndex = find('notes', 'note', 'comment');

        if (passwordIndex === -1 || (urlIndex === -1 && usernameIndex === -1)) {
            throw new Error('Could not find url/username/password columns in the CSV file');
        }

        const entries: ImportedEntry[] = [];
        for (const row of rows) {
            const password = row[passwordIndex] ?? '';
            if (!password) continue;
            const url = urlIndex === -1 ? '' : (row[urlIndex] ?? '');
            entries.push({
                title: (titleIndex !== -1 && row[titleIndex]) || this.hostnameOf(url) || 'Untitled',
                username: usernameIndex === -1 ? '' : (row[usernameIndex] ?? ''),
                password,
                url: url || undefined,
                notes: notesIndex === -1 ? undefined : (row[notesIndex] || undefined),
            });
        }
        if (entries.length === 0) {
            throw new Error('No entries with passwords found in the CSV file');
        }
        return { source: 'CSV', entries, skipped: 0 };
    }

    private static hostnameOf(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    }

    // ---- Writing into the database ----

    // Creates the imported groups and entries without saving; used both when
    // importing into an open database and when seeding a brand new one
    static writeEntries(result: ImportResult, kdbxDb: kdbxweb.Kdbx): void {
        const root = kdbxDb.createGroup(kdbxDb.getDefaultGroup(), `Imported (${result.source})`);
        const groupCache = new Map<string, kdbxweb.KdbxGroup>();

        const groupFor = (path?: string[]): kdbxweb.KdbxGroup => {
            if (!path || path.length === 0) return root;
            let parent = root;
            let key = '';
            for (const segment of path) {
                const name = segment.trim();
                if (!name) continue;
                key += '/' + name;
                let group = groupCache.get(key);
                if (!group) {
                    group = kdbxDb.createGroup(parent, name);
                    groupCache.set(key, group);
                }
                parent = group;
            }
            return parent;
        };

        for (const imported of result.entries) {
            const entry = kdbxDb.createEntry(groupFor(imported.group));
            entry.fields.set('Title', imported.title);
            entry.fields.set('UserName', imported.username);
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(imported.password));
            if (imported.url) entry.fields.set('URL', imported.url);
            if (imported.notes) entry.fields.set('Notes', imported.notes);

            if (imported.totp) {
                // Normalize bare secrets into otpauth URIs (KeePassXC-compatible)
                const uri = imported.totp.toLowerCase().startsWith('otpauth://')
                    ? imported.totp
                    : (() => {
                        const config = TotpService.parseUserInput(imported.totp);
                        return config ? TotpService.buildOtpAuthUri(config, imported.title) : null;
                    })();
                if (uri) {
                    entry.fields.set('otp', kdbxweb.ProtectedValue.fromString(uri));
                }
            }

            for (const field of imported.customFields ?? []) {
                entry.fields.set(field.key, field.protected
                    ? kdbxweb.ProtectedValue.fromString(field.value)
                    : field.value);
            }
        }
    }

    static async importToDatabase(result: ImportResult, kdbxDb: kdbxweb.Kdbx): Promise<number> {
        this.writeEntries(result, kdbxDb);
        const database = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
        await KeepassDatabaseService.saveDatabase(database, kdbxDb);
        return result.entries.length;
    }
}

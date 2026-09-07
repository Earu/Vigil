import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { TotpService } from './TotpService';
import { PASSKEY_ATTRIBUTES, b64urlEncode } from './PasskeyService';
import { SshAgentService, DEFAULT_KEEAGENT_SETTINGS, KEEAGENT_SETTINGS_ATTACHMENT } from './SshAgentService';
import { is1PuxArchive, parse1Pux, parse1Pif, PIF_SEPARATOR } from './OnePasswordImport';
import { looksLikeKeePassXml, parseKeePassXml, looksLikeKeePassHtmlReport } from './KeePassXcImport';

export interface ImportedEntry {
    title: string;
    username: string;
    password: string;
    url?: string;
    notes?: string;
    totp?: string; // otpauth URI or bare base32 secret
    group?: string[]; // folder path, outermost first
    tags?: string[];
    customFields?: Array<{ key: string; value: string; protected: boolean }>;
    // Everything below is carried by a Bitwarden export and has somewhere to
    // live in a kdbx entry. Dropping any of it looks like a clean import
    // while credentials go missing, so each has a home rather than a comment
    // saying it was skipped.

    // URLs past the first. A kdbx entry has one URL field, so the rest go to
    // the KP2A_URL_n attributes KeePassXC and Keepass2Android both read
    extraUrls?: string[];
    // Older passwords, oldest first. Replayed into the entry's kdbx history
    passwordHistory?: Array<{ password: string; changed?: Date }>;
    // A private key to attach, with a KeeAgent record pointing at it
    sshKey?: { fileName: string; privateKey: string; publicKey?: string };
    // Files the source stored on the item, kept as entry attachments
    attachments?: Array<{ name: string; data: Uint8Array }>;
    // A WebAuthn credential, in the KPEX_PASSKEY_* shape KeePassXC uses
    passkey?: {
        credentialId: string; // base64url of the raw id
        privateKeyPem: string;
        relyingParty: string;
        username: string;
        userHandle: string; // base64url
    };
}

export interface ImportResult {
    source: 'Bitwarden' | 'LastPass' | '1Password' | 'KeePassXC' | 'CSV';
    entries: ImportedEntry[];
    skipped: number; // items of unsupported types (cards, identities, ...)
}

export class ImportService {
    // Exports that carry tags put them in one cell, delimited by whatever the
    // tool preferred. normalizeTags does the rest (kdbx delimiters, blanks,
    // duplicates)
    private static splitTags(value: string): string[] | undefined {
        if (!value) return undefined;
        const tags = KeepassDatabaseService.normalizeTags(value.split(/[;,|]/));
        return tags.length > 0 ? tags : undefined;
    }

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
        // Read as bytes, because a .1pux is a zip and decoding one as text
        // destroys it. Everything else is decoded from the same bytes
        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = file.name.toLowerCase();

        if (name.endsWith('.1pux') || is1PuxArchive(bytes)) {
            return { source: '1Password', entries: parse1Pux(bytes), skipped: 0 };
        }

        const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
        const trimmed = text.trim();

        // JSON Lines with separator records between them, which is neither
        // one JSON document nor a CSV
        if (name.endsWith('.1pif') || text.includes(PIF_SEPARATOR)) {
            const entries = parse1Pif(text);
            if (entries.length === 0) throw new Error('The file contains no entries');
            return { source: '1Password', entries, skipped: 0 };
        }

        if (trimmed.startsWith('{') || name.endsWith('.json')) {
            return this.parseBitwardenJson(trimmed);
        }

        // KeePassXC's XML export, recognised by its content rather than its
        // extension
        if (looksLikeKeePassXml(trimmed)) {
            const entries = parseKeePassXml(trimmed);
            if (entries.length === 0) throw new Error('The file contains no entries');
            return { source: 'KeePassXC', entries, skipped: 0 };
        }
        // Its HTML export is a printable report, not an interchange format:
        // it carries no attachments, history, tags or field protection, and
        // truncates a URL past a hundred characters because it is meant to be
        // read off paper. Named here so it is refused for what it is rather
        // than falling through to the CSV reader and being called empty
        if (looksLikeKeePassHtmlReport(trimmed)) {
            throw new Error('That is a KeePassXC HTML report, which is made for printing and leaves data out. Export as XML or CSV instead.');
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
        if (has('group', 'title', 'username', 'password', 'url')) {
            return this.parseKeePassXcCsv(headers, rows.slice(1));
        }
        if (has('title', 'username', 'password') && (headers.includes('otpauth') || headers.includes('archived'))) {
            return this.parseOnePasswordCsv(headers, rows.slice(1));
        }
        return this.parseGenericCsv(headers, rows.slice(1));
    }

    // ---- Bitwarden ----

    // A value out of the JSON file, which is whatever was on disk rather than
    // something Bitwarden necessarily wrote. Every field below used to travel
    // untouched into a kdbx field map, so a number was stored as a number and
    // an object reached ProtectedValue.fromString. Strings pass, a finite
    // number is spelled out (exports do carry numeric names), and everything
    // else reads as absent rather than as "[object Object]"
    private static jsonText(value: unknown): string | undefined {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return undefined;
    }

    // Bitwarden's private key material is base64url (Fido2Utils.arrayToString
    // is base64 with the two characters swapped and the padding stripped),
    // and KeePassXC's passkey attribute holds a PKCS#8 PEM. The bytes are the
    // same either way, so this is a re-spelling rather than a decode
    private static pkcs8PemFromB64Url(value: string): string | null {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const body = padded.match(/.{1,64}/g)?.join('\n');
        return body ? `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n` : null;
    }

    // Bitwarden writes a credential id either as a plain GUID or with a 'b64.'
    // prefix on a base64url one (parseCredentialId in the clients repo reads
    // both). A GUID stands for its sixteen raw bytes in written order, which
    // is what guidToRawFormat produces and what the attribute has to hold
    private static credentialIdToB64Url(value: string): string | null {
        if (value.startsWith('b64.')) return value.slice(4) || null;
        const hex = value.replace(/-/g, '');
        if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return b64urlEncode(bytes);
    }

    // A file name for a key Bitwarden stores without one. Nothing depends on
    // it (keyCandidates offers any attachment opening with a PEM banner), so
    // it only has to be a plausible, safe file name
    private static sshFileName(title: string): string {
        const clean = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 60);
        return clean ? `${clean}.key` : 'id_imported.key';
    }

    private static passkeyFrom(raw: any): ImportedEntry['passkey'] | undefined {
        const credentialId = this.credentialIdToB64Url(this.jsonText(raw?.credentialId) ?? '');
        const privateKeyPem = this.pkcs8PemFromB64Url(this.jsonText(raw?.keyValue) ?? '');
        const relyingParty = this.jsonText(raw?.rpId);
        // Without any of these the credential cannot sign for anyone, so it
        // is dropped rather than stored as a passkey that never works
        if (!credentialId || !privateKeyPem || !relyingParty) return undefined;
        return {
            credentialId,
            privateKeyPem,
            relyingParty,
            username: this.jsonText(raw?.userName) ?? '',
            userHandle: this.jsonText(raw?.userHandle) ?? '',
        };
    }

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

        // An individual export groups by `folders` and names one per item in
        // `folderId`. An organization export has no folders at all: it
        // carries `collections` and each item lists `collectionIds`. Both are
        // a flat list of named containers, so both become groups here; an
        // org export used to land every entry loose in the import group
        const groupNames = new Map<string, string>(
            [
                ...(Array.isArray(data.folders) ? data.folders : []),
                ...(Array.isArray(data.collections) ? data.collections : []),
            ].flatMap((f: any): Array<[string, string]> => {
                const id = this.jsonText(f?.id);
                const name = this.jsonText(f?.name);
                return id && name ? [[id, name]] : [];
            })
        );

        const entries: ImportedEntry[] = [];
        let skipped = 0;
        for (const item of data.items) {
            // A JSON file holds whatever is in it; an item that is not an
            // object has no type to read and no fields to take
            if (!item || typeof item !== 'object') {
                skipped++;
                continue;
            }
            // CipherType: 1 login, 2 secure note, 5 ssh key. Cards,
            // identities, bank accounts, driving licences and passports have
            // no shape in a kdbx entry and are counted instead
            if (item.type !== 1 && item.type !== 2 && item.type !== 5) {
                skipped++;
                continue;
            }

            // An item belongs to one group here: its folder, or the first
            // collection it is filed under
            const folderId = this.jsonText(item.folderId)
                ?? (Array.isArray(item.collectionIds) ? this.jsonText(item.collectionIds[0]) : undefined);
            const folder = folderId ? groupNames.get(folderId) : undefined;
            const customFields = (Array.isArray(item.fields) ? item.fields : []).flatMap((f: any) => {
                const key = this.jsonText(f?.name);
                // 3 = linked field, which references another field rather than
                // holding a value
                if (!key || f?.type === 3) return [];
                return [{ key, value: this.jsonText(f?.value) ?? '', protected: f?.type === 1 }];
            });

            // uris is indexed only once it is known to be a list: a string
            // there would yield its first character as the URL
            const uris = (Array.isArray(item.login?.uris) ? item.login.uris : [])
                .flatMap((u: any) => {
                    const uri = this.jsonText(u?.uri);
                    return uri ? [uri] : [];
                }) as string[];

            // Newest first in the file; replayed oldest first into history
            const history = (Array.isArray(item.passwordHistory) ? item.passwordHistory : [])
                .flatMap((h: any) => {
                    const password = this.jsonText(h?.password);
                    if (password === undefined) return [];
                    const at = Date.parse(this.jsonText(h?.lastUsedDate) ?? '');
                    return [{ password, changed: Number.isFinite(at) ? new Date(at) : undefined }];
                })
                .sort((a: { changed?: Date }, b: { changed?: Date }) =>
                    (a.changed?.getTime() ?? 0) - (b.changed?.getTime() ?? 0));

            const passkeys = (Array.isArray(item.login?.fido2Credentials) ? item.login.fido2Credentials : [])
                .flatMap((c: any) => {
                    const passkey = this.passkeyFrom(c);
                    return passkey ? [passkey] : [];
                }) as NonNullable<ImportedEntry['passkey']>[];

            const title = this.jsonText(item.name) ?? 'Untitled';
            const group = folder ? folder.split('/') : undefined;
            const privateKey = item.type === 5 ? this.jsonText(item.sshKey?.privateKey) : undefined;

            entries.push({
                title,
                username: this.jsonText(item.login?.username) ?? '',
                password: this.jsonText(item.login?.password) ?? '',
                url: uris[0],
                notes: this.jsonText(item.notes),
                totp: this.jsonText(item.login?.totp),
                group,
                customFields: customFields.length ? customFields : undefined,
                extraUrls: uris.length > 1 ? uris.slice(1) : undefined,
                passwordHistory: history.length ? history : undefined,
                // An entry holds one passkey, which is all Bitwarden's own UI
                // creates; the array is the model's, so any beyond the first
                // get an entry of their own below rather than being dropped
                passkey: passkeys[0],
                sshKey: privateKey
                    ? {
                        fileName: this.sshFileName(title),
                        privateKey,
                        publicKey: this.jsonText(item.sshKey?.publicKey),
                    }
                    : undefined,
            });

            for (const passkey of passkeys.slice(1)) {
                entries.push({
                    title: `${title} (${passkey.relyingParty} passkey)`,
                    username: passkey.username,
                    password: '',
                    group,
                    passkey,
                });
            }
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
            // An organization export has no folder column: it writes
            // `collections`, comma separated because an item can be filed
            // under several. The first is the group, as in the JSON path
            const folder = get(row, 'folder')
                || (get(row, 'collections').split(',')[0] ?? '').trim();
            // login_uri holds every URL in one cell, comma separated; taking
            // the cell whole produced a URL of "https://a,https://b"
            const uris = get(row, 'login_uri').split(',').map(u => u.trim()).filter(Boolean);
            entries.push({
                title: get(row, 'name') || 'Untitled',
                username: get(row, 'login_username'),
                password: get(row, 'login_password'),
                url: uris[0],
                notes: get(row, 'notes') || undefined,
                totp: get(row, 'login_totp') || undefined,
                group: folder ? folder.split('/') : undefined,
                extraUrls: uris.length > 1 ? uris.slice(1) : undefined,
                customFields: this.parseCsvFields(get(row, 'fields')),
            });
        }
        return { source: 'Bitwarden', entries, skipped };
    }

    // Bitwarden flattens an item's custom fields into one cell: a line per
    // field, "name: value", with the name allowed to contain ": " so the
    // split is on the last one (buildCommonCipher writes them, and their own
    // importer reads them back this way). The CSV carries no field type, so
    // nothing here can be marked protected the way the JSON path does
    private static parseCsvFields(cell: string): ImportedEntry['customFields'] {
        const fields = cell.split(/\r?\n/).flatMap(line => {
            const at = line.lastIndexOf(': ');
            if (at === -1) return [];
            const key = line.slice(0, at);
            return key ? [{ key, value: line.slice(at + 2), protected: false }] : [];
        });
        return fields.length ? fields : undefined;
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
            // LastPass writes the literal "(none)" for an item in no folder,
            // which became a group of that name
            const rawGrouping = get(row, 'grouping');
            const grouping = rawGrouping === '(none)' ? '' : rawGrouping;
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

    // ---- KeePassXC (and Vigil's own) CSV export ----

    private static parseKeePassXcCsv(headers: string[], rows: string[][]): ImportResult {
        const col = (name: string) => headers.indexOf(name);
        const get = (row: string[], name: string) => {
            const index = col(name);
            return index === -1 ? '' : (row[index] ?? '');
        };

        const entries: ImportedEntry[] = [];
        for (const row of rows) {
            // group paths start with the database's root group name; drop it
            const group = get(row, 'group').split('/').slice(1).filter(s => s.length > 0);
            entries.push({
                title: get(row, 'title') || 'Untitled',
                username: get(row, 'username'),
                password: get(row, 'password'),
                url: get(row, 'url') || undefined,
                notes: get(row, 'notes') || undefined,
                totp: get(row, 'totp') || undefined,
                group: group.length ? group : undefined,
            });
        }
        return { source: 'KeePassXC', entries, skipped: 0 };
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
                tags: this.splitTags(get(row, 'tags')),
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
        const tagsIndex = find('tags', 'tag', 'labels');

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
                tags: tagsIndex === -1 ? undefined : this.splitTags(row[tagsIndex] ?? ''),
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

    // An entry is one field map, so a custom field named like a standard one
    // lands on top of it. A Bitwarden export may carry a field called
    // "Password" (the name is the user's to choose), and writing it took the
    // real password with it and left the value unprotected where a
    // ProtectedValue had been. Both values are the user's, so the custom one
    // is renamed rather than dropped. otp and the passkey attributes are
    // reserved for the same reason: they are written from the entry's own
    // data, here and by PasskeyService, and an import must not forge one.
    // Names are compared exactly, as kdbx compares them: "password" is a
    // different field from "Password" and needs no renaming
    private static readonly RESERVED_FIELD_NAMES: readonly string[] = [
        ...KeepassDatabaseService.STANDARD_FIELDS,
        'otp',
        ...Object.values(PASSKEY_ATTRIBUTES),
    ];

    // The first spelling of `key` that nothing on this entry has claimed.
    // Also separates two custom fields that arrived under the same name,
    // which used to mean the second silently replaced the first
    private static freeFieldName(key: string, taken: Set<string>): string {
        if (!taken.has(key)) return key;
        for (let suffix = 2; ; suffix++) {
            const candidate = `${key}_${suffix}`;
            if (!taken.has(candidate)) return candidate;
        }
    }

    // createBinary takes an ArrayBuffer. Copied into a fresh one from the
    // global constructor rather than handed the encoder's own: kdbxweb tests
    // it with `instanceof ArrayBuffer` and falls through to reading .buffer
    // off it when that says no, which it does whenever the encoder allocated
    // in a different realm than the ArrayBuffer in scope. One realm in the
    // renderer, two under jsdom, and the copy costs nothing at these sizes
    private static toBuffer(bytes: Uint8Array): ArrayBuffer {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
    }

    private static utf8Buffer(text: string): ArrayBuffer {
        return this.toBuffer(new TextEncoder().encode(text));
    }

    // Creates the imported groups and entries without saving; used both when
    // importing into an open database and when seeding a brand new one
    static async writeEntries(result: ImportResult, kdbxDb: kdbxweb.Kdbx): Promise<void> {
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
            if (imported.tags?.length) entry.tags = KeepassDatabaseService.normalizeTags(imported.tags);

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

            const taken = new Set<string>(this.RESERVED_FIELD_NAMES);

            // A kdbx entry has one URL field. The rest go where KeePassXC and
            // Keepass2Android both look for them, claiming their names before
            // the custom fields so a KP2A_URL_1 in the export cannot land on
            // one of these
            imported.extraUrls?.forEach((url, index) => {
                const name = this.freeFieldName(`KP2A_URL_${index + 1}`, taken);
                taken.add(name);
                entry.fields.set(name, url);
            });

            // The passkey attributes are reserved names, so nothing else has
            // claimed them. Same three values protected as PasskeyService
            // protects when it mints one, so an imported credential and a
            // Vigil-created one are the same entry shape
            if (imported.passkey) {
                const passkey = imported.passkey;
                entry.fields.set(PASSKEY_ATTRIBUTES.credentialId, kdbxweb.ProtectedValue.fromString(passkey.credentialId));
                entry.fields.set(PASSKEY_ATTRIBUTES.privateKeyPem, kdbxweb.ProtectedValue.fromString(passkey.privateKeyPem));
                entry.fields.set(PASSKEY_ATTRIBUTES.userHandle, kdbxweb.ProtectedValue.fromString(passkey.userHandle));
                entry.fields.set(PASSKEY_ATTRIBUTES.relyingParty, passkey.relyingParty);
                entry.fields.set(PASSKEY_ATTRIBUTES.username, passkey.username);
                if (!entry.tags.includes('Passkey')) entry.tags = [...entry.tags, 'Passkey'];
            }

            // The key file as an attachment plus the KeeAgent record naming
            // it, which is how Vigil and KeePassXC both find it. Bitwarden
            // stores the key unencrypted, so the entry password stays empty
            // and that is the passphrase. addAtDatabaseOpen is left off: an
            // import must not quietly start pushing keys into the agent
            // Before the SSH key, so a key file cannot be displaced by a
            // document that happens to share its name
            for (const attachment of imported.attachments ?? []) {
                entry.binaries.set(attachment.name, await kdbxDb.createBinary(this.toBuffer(attachment.data)));
            }

            if (imported.sshKey) {
                const { fileName, privateKey, publicKey } = imported.sshKey;
                entry.binaries.set(fileName, await kdbxDb.createBinary(this.utf8Buffer(privateKey)));
                if (publicKey) {
                    entry.binaries.set(`${fileName}.pub`, await kdbxDb.createBinary(this.utf8Buffer(publicKey)));
                }
                const settings = {
                    ...DEFAULT_KEEAGENT_SETTINGS,
                    allowUseOfSshKey: true,
                    selectedType: 'attachment' as const,
                    attachmentName: fileName,
                };
                entry.binaries.set(
                    KEEAGENT_SETTINGS_ATTACHMENT,
                    await kdbxDb.createBinary(this.utf8Buffer(SshAgentService.serializeSettings(settings)))
                );
            }

            for (const field of imported.customFields ?? []) {
                const name = this.freeFieldName(field.key, taken);
                taken.add(name);
                // A field the source did not mark hidden but that was named
                // after one of ours is protected anyway: whatever someone
                // typed under the label "Password" is a secret far more often
                // than it is not, and masking a value that turns out to be
                // ordinary text costs the user nothing they cannot undo.
                // Two custom fields sharing a name say nothing of the sort,
                // so a rename for that reason leaves the flag alone
                const protect = field.protected || this.RESERVED_FIELD_NAMES.includes(field.key);
                entry.fields.set(name, protect
                    ? kdbxweb.ProtectedValue.fromString(field.value)
                    : field.value);
            }

            // Last, because a kdbx history item is a snapshot of the whole
            // entry rather than a password on its own: every field above has
            // to be in place before the first one is taken. Bitwarden records
            // only the old passwords, so each revision carries today's other
            // values and the date that password stopped being current, which
            // is the closest the two models come to each other
            for (const revision of imported.passwordHistory ?? []) {
                entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(revision.password));
                if (revision.changed) entry.times.lastModTime = revision.changed;
                entry.pushHistory();
            }
            if (imported.passwordHistory?.length) {
                entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(imported.password));
                entry.times.lastModTime = new Date();
            }
        }
    }

    static async importToDatabase(result: ImportResult, kdbxDb: kdbxweb.Kdbx): Promise<number> {
        await this.writeEntries(result, kdbxDb);
        const database = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
        await KeepassDatabaseService.saveDatabase(database, kdbxDb);
        return result.entries.length;
    }
}

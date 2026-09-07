import { unzipSync, strFromU8 } from 'fflate';
import type { ImportedEntry } from './ImportService';

// 1Password's two archive formats, which is what its own export dialog
// produces. The CSV it also offers carries logins only, by 1Password's own
// documentation, so anyone following the recommended path arrives with one
// of these and used to be told their file held no entries.
//
//   .1pux  the current format: a zip whose export.data is JSON, laid out as
//          accounts > vaults > items, with Document items' files beside it
//          under files/ (see documentOf).
//   .1pif  the older interchange format: JSON Lines, one item per line, with
//          separator lines between them that are not JSON at all. A 1PIF
//          export is a folder, and its attachments are separate files in
//          that folder rather than inside the .1pif, so a file picker that
//          hands over one file can never see them.
//
// Field names follow bitwarden/clients libs/importer/src/importers/onepassword,
// which is the maintained reading of both formats.

// export.data > accounts > vaults > items
interface PuxItem {
    state?: string;
    categoryUuid?: string;
    details?: {
        loginFields?: Array<{ value?: unknown; id?: unknown; name?: unknown; fieldType?: unknown; designation?: unknown }> | null;
        notesPlain?: unknown;
        password?: unknown;
        sections?: Array<{ title?: unknown; fields?: Array<PuxField> | null } | null> | null;
        passwordHistory?: Array<{ value?: unknown; time?: unknown } | null> | null;
        documentAttributes?: { fileName?: unknown; documentId?: unknown; decryptedSize?: unknown } | null;
    } | null;
    overview?: {
        title?: unknown;
        url?: unknown;
        urls?: Array<{ url?: unknown } | null> | null;
        tags?: unknown;
    } | null;
}

interface PuxField {
    title?: unknown;
    id?: unknown;
    value?: Record<string, unknown> | null;
}

const text = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
};

// A 1pux field value is an object with exactly one populated key naming its
// kind: string, concealed, totp, url, phone, date, and so on. Only the ones
// that are text carry over; a date or a menu choice has no field of its own
// in a kdbx entry and reads as its printed form
const KEY_ORDER = ['string', 'concealed', 'url', 'email', 'phone', 'totp', 'creditCardNumber', 'reference', 'menu', 'gender', 'date', 'monthYear'];

// Whole seconds as a Date, or nothing. Finite is not the same as
// representable: 1e15 passes Number.isFinite and lands past year 275760,
// where new Date gives an Invalid Date. One of those reaching an entry's
// times makes the whole database refuse to serialize, so it stops here
const secondsToDate = (raw: unknown): Date | undefined => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    const at = new Date(raw * 1000);
    return Number.isNaN(at.getTime()) ? undefined : at;
};

// 1Password keeps a date as whole seconds and a monthYear as the number
// YYYYMM. Stored raw they read as "1700000000", which says nothing to
// whoever opens the entry later
function spellDate(raw: unknown): string | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return text(raw);
    return secondsToDate(raw)?.toISOString().slice(0, 10);
}

function spellMonthYear(raw: unknown): string | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return text(raw);
    const value = Math.trunc(raw);
    const month = value % 100;
    if (month < 1 || month > 12) return String(value);
    return `${Math.trunc(value / 100)}-${String(month).padStart(2, '0')}`;
}

function valueOf(value: Record<string, unknown> | null | undefined): { text: string; kind: string } | null {
    if (!value) return null;
    for (const key of KEY_ORDER) {
        const raw = value[key];
        if (raw === undefined || raw === null || raw === '') continue;
        // email is an object, date and monthYear are numbers standing for
        // something else; the rest of the list is already text
        const spelled = key === 'email' ? text((raw as { email_address?: unknown })?.email_address)
            : key === 'date' ? spellDate(raw)
                : key === 'monthYear' ? spellMonthYear(raw)
                    : text(raw);
        if (spelled) return { text: spelled, kind: key };
    }
    return null;
}

// The private key material 1Password stores for an SSH key item
function sshKeyOf(value: Record<string, unknown> | null | undefined): ImportedEntry['sshKey'] | undefined {
    const raw = value?.sshKey as { privateKey?: unknown; metadata?: { publicKey?: unknown } } | undefined;
    const privateKey = text(raw?.privateKey);
    if (!privateKey) return undefined;
    return { fileName: '', privateKey, publicKey: text(raw?.metadata?.publicKey) };
}

const uniqueUrls = (urls: Array<string | undefined>): string[] => {
    const seen = new Set<string>();
    return urls.filter((url): url is string => {
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
    });
};

// A Document item names the file it stands for, and the archive stores it
// under files/<documentId>___<fileName> (three underscores; see 1Password's
// "About the 1Password Unencrypted Export format"). Matched on the id alone
// rather than the whole name, because the file name in the path has been
// through whatever the exporting platform does to file names
function documentOf(item: PuxItem, files: Map<string, Uint8Array>): ImportedEntry['attachments'] {
    const attributes = item.details?.documentAttributes;
    const documentId = text(attributes?.documentId);
    if (!documentId) return undefined;
    const data = files.get(documentId);
    if (!data) return undefined;
    const name = text(attributes?.fileName) || documentId;
    return [{ name, data }];
}

function puxEntry(item: PuxItem, group: string[] | undefined, files: Map<string, Uint8Array>): ImportedEntry | null {
    const details = item.details ?? {};
    const overview = item.overview ?? {};
    const title = text(overview.title) || 'Untitled';

    let username = '';
    let password = '';
    const customFields: NonNullable<ImportedEntry['customFields']> = [];
    let totp: string | undefined;
    let sshKey: ImportedEntry['sshKey'] | undefined;

    for (const field of details.loginFields ?? []) {
        const value = text(field?.value);
        if (!value) continue;
        if (field?.designation === 'username' && !username) { username = value; continue; }
        if (field?.designation === 'password' && !password) { password = value; continue; }
        const name = text(field?.name) || text(field?.id);
        // fieldType P is a password box, so its value is treated as one
        if (name) customFields.push({ key: name, value, protected: field?.fieldType === 'P' });
    }
    // A Password-category item carries no login fields, only this
    if (!password) password = text(details.password) ?? '';

    for (const section of details.sections ?? []) {
        const sectionTitle = text(section?.title);
        for (const field of section?.fields ?? []) {
            const key = sshKeyOf(field?.value);
            if (key) { sshKey ??= key; continue; }
            const value = valueOf(field?.value);
            if (!value) continue;
            // A one-time code is identified by the field's id, not its title
            if (value.kind === 'totp' && String(field?.id ?? '').startsWith('TOTP_')) {
                totp ??= value.text;
                continue;
            }
            const label = text(field?.title) || text(field?.id) || 'Field';
            customFields.push({
                key: sectionTitle ? `${sectionTitle} / ${label}` : label,
                value: value.text,
                protected: value.kind === 'concealed',
            });
        }
    }

    const urls = uniqueUrls([
        text(overview.url),
        ...(overview.urls ?? []).map(u => text(u?.url)),
    ]);

    const history = (details.passwordHistory ?? []).flatMap(revision => {
        const value = text(revision?.value);
        if (value === undefined) return [];
        return [{
            password: value,
            // 1Password stamps these in whole seconds
            changed: secondsToDate(revision?.time),
        }];
    }).sort((a, b) => (a.changed?.getTime() ?? 0) - (b.changed?.getTime() ?? 0));

    const tags = Array.isArray(overview.tags)
        ? (overview.tags as unknown[]).flatMap(t => { const s = text(t); return s ? [s] : []; })
        : undefined;

    const attachments = documentOf(item, files);

    // An item with nothing in it at all is not worth an entry
    if (!username && !password && !totp && !sshKey && !attachments && customFields.length === 0
        && !text(details.notesPlain) && urls.length === 0) {
        return null;
    }

    return {
        title,
        username,
        password,
        url: urls[0],
        notes: text(details.notesPlain),
        totp,
        group,
        tags: tags?.length ? tags : undefined,
        customFields: customFields.length ? customFields : undefined,
        extraUrls: urls.length > 1 ? urls.slice(1) : undefined,
        passwordHistory: history.length ? history : undefined,
        sshKey: sshKey ? { ...sshKey, fileName: sshFileName(title) } : undefined,
        attachments,
    };
}

// 1Password names an SSH key item but not the file, so one is made from the
// title. Nothing depends on it: an attachment opening with a PEM banner is
// offered as a key whatever it is called
function sshFileName(title: string): string {
    const clean = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 60);
    return clean ? `${clean}.key` : 'id_imported.key';
}

export function is1PuxArchive(bytes: Uint8Array): boolean {
    // Local file header of a zip
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// The most a .1pux may unpack to. A zip names the uncompressed size of each
// file it holds, and a few hundred kilobytes on disk can name gigabytes on
// the way out; unpacked without a bound that takes the renderer, and any
// unsaved edit, down with it. The same hazard QrScanService caps for images.
//
// The declared size is worth trusting here because fflate allocates exactly
// it and inflates into that fixed buffer, so a header claiming less than the
// data holds fails the inflate rather than growing past it.
//
// Well above a real export, which is text plus whatever documents were
// attached to items, and in step with the bound on a vault itself
// (conflict-copies MAX_VAULT_BYTES): an import larger than this would build
// a vault Vigil then refuses to open
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

// The bound is a parameter so the tests can reach it with a small archive
// rather than by building a real bomb, the way checkArgon2Params takes the
// machine's memory and readBoundedFile takes its cap
export function parse1Pux(bytes: Uint8Array, maxUnpackedBytes = MAX_UNPACKED_BYTES): ImportedEntry[] {
    let unpacked: Record<string, Uint8Array>;
    // Set by the filter rather than thrown from it: a throw there is caught
    // below as a damaged archive, which is the wrong thing to tell someone
    // whose file is merely too big
    let tooLarge = false;
    try {
        // export.data plus the Document items under files/. export.attributes
        // holds only viewer metadata and is left packed
        let unpackedBytes = 0;
        unpacked = unzipSync(bytes, {
            filter: file => {
                if (file.name !== 'export.data' && !file.name.startsWith('files/')) return false;
                // Counted before the file is taken, and once the budget is
                // gone nothing else is: the filter runs ahead of the inflate,
                // so a rejected file is never unpacked at all
                unpackedBytes += file.originalSize;
                if (unpackedBytes > maxUnpackedBytes) tooLarge = true;
                return !tooLarge;
            },
        });
    } catch {
        throw new Error('That .1pux file could not be opened; it may be damaged');
    }
    if (tooLarge) {
        throw new Error('That .1pux file unpacks to more than Vigil will read; export it again without its documents');
    }
    const manifest = unpacked['export.data'];
    if (!manifest) {
        throw new Error('That .1pux file has no export.data inside it');
    }

    // files/<documentId>___<fileName>, keyed on the id, which is what the
    // item names. The separator is three underscores
    const files = new Map<string, Uint8Array>();
    for (const [path, data] of Object.entries(unpacked)) {
        if (path === 'export.data') continue;
        const name = path.slice('files/'.length);
        const at = name.indexOf('___');
        files.set(at === -1 ? name : name.slice(0, at), data);
    }

    let data: { accounts?: Array<{ vaults?: Array<{ attrs?: { name?: unknown }; items?: PuxItem[] | null } | null> | null } | null> };
    try {
        data = JSON.parse(strFromU8(manifest));
    } catch {
        throw new Error('The export.data inside that .1pux file is not valid JSON');
    }

    const entries: ImportedEntry[] = [];
    for (const account of data.accounts ?? []) {
        for (const vault of account?.vaults ?? []) {
            // Every vault becomes a group, since a 1Password account normally
            // has several and their names are the only structure it exports
            const name = text(vault?.attrs?.name);
            const group = name ? [name] : undefined;
            for (const item of vault?.items ?? []) {
                if (!item || typeof item !== 'object') continue;
                const entry = puxEntry(item, group, files);
                if (entry) entries.push(entry);
            }
        }
    }
    return entries;
}

// The separator 1Password writes between records. Its presence is what tells
// a .1pif from any other file of JSON lines
export const PIF_SEPARATOR = '***5642bee8-a5ff-11dc-8314-0800200c9a66***';

export function parse1Pif(content: string): ImportedEntry[] {
    const entries: ImportedEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
        // Separator lines and blanks are not JSON and are not items
        if (line.length === 0 || line[0] !== '{') continue;
        let item: any;
        try {
            item = JSON.parse(line);
        } catch {
            continue;
        }
        if (!item || typeof item !== 'object' || item.trashed === true) continue;

        const secure = item.secureContents ?? {};
        let username = '';
        let password = text(secure.password) ?? '';
        const customFields: NonNullable<ImportedEntry['customFields']> = [];
        let totp: string | undefined;

        // Top-level fields name their role in `designation`
        for (const field of Array.isArray(secure.fields) ? secure.fields : []) {
            const value = text(field?.value);
            if (!value) continue;
            if (field?.designation === 'username' && !username) { username = value; continue; }
            if (field?.designation === 'password' && !password) { password = value; continue; }
            const name = text(field?.name);
            if (name) customFields.push({ key: name, value, protected: field?.type === 'P' });
        }

        // Section fields carry short keys: n is the name, v the value, t the
        // title shown, k the kind
        for (const section of Array.isArray(secure.sections) ? secure.sections : []) {
            for (const field of Array.isArray(section?.fields) ? section.fields : []) {
                const value = text(field?.v);
                if (!value) continue;
                const name = text(field?.n) ?? '';
                if (name.startsWith('TOTP_')) { totp ??= value; continue; }
                const label = text(field?.t) || name || 'Field';
                const sectionTitle = text(section?.title);
                customFields.push({
                    key: sectionTitle ? `${sectionTitle} / ${label}` : label,
                    value,
                    protected: field?.k === 'concealed',
                });
            }
        }

        const history = (Array.isArray(secure.passwordHistory) ? secure.passwordHistory : [])
            .flatMap((revision: any) => {
                const value = text(revision?.value);
                if (value === undefined) return [];
                return [{ password: value, changed: secondsToDate(revision?.time) }];
            })
            .sort((a: { changed?: Date }, b: { changed?: Date }) => (a.changed?.getTime() ?? 0) - (b.changed?.getTime() ?? 0));

        const notes = text(secure.notesPlain);
        const url = text(item.location);
        if (!username && !password && !totp && customFields.length === 0 && !notes && !url) continue;

        entries.push({
            title: text(item.title) || 'Untitled',
            username,
            password,
            url,
            notes,
            totp,
            customFields: customFields.length ? customFields : undefined,
            passwordHistory: history.length ? history : undefined,
        });
    }
    return entries;
}

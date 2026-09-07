import { gunzipSync } from 'fflate';
import type { ImportedEntry } from './ImportService';

// KeePassXC's XML export: the KeePass2 document, the same shape as the
// cleartext inside a kdbx. KeePassFile > Root > Group, entries as String
// key/value pairs, attachments inlined under Meta > Binaries.
//
// Its CSV is one row per entry and drops attachments, history and everything
// protected about a field, so this is the export to hand over when the kdbx
// itself cannot be. The third export, HTML, is a printable report rather
// than an interchange format and is refused with a message saying so.

const PASSKEY_KEYS = {
    username: 'KPEX_PASSKEY_USERNAME',
    credentialId: 'KPEX_PASSKEY_CREDENTIAL_ID',
    privateKeyPem: 'KPEX_PASSKEY_PRIVATE_KEY_PEM',
    relyingParty: 'KPEX_PASSKEY_RELYING_PARTY',
    userHandle: 'KPEX_PASSKEY_USER_HANDLE',
} as const;

const STANDARD = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

function parseDocument(text: string): Document | null {
    if (typeof DOMParser === 'undefined') return null;
    try {
        // codeql[js/xss-through-dom]: parseFromString is modelled as an HTML
        // sink whatever the type argument says. This is application/xml, and
        // the caller reads text and attributes out and drops the document.
        // Verified in Chromium: parsing runs no script, an external entity
        // resolves to nothing, an entity bomb is refused. Adopting these
        // nodes into a live document would run the script; nothing does
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
    } catch {
        return null;
    }
}

const childrenNamed = (node: Element, name: string): Element[] =>
    Array.from(node.children).filter(child => child.tagName === name);

const childNamed = (node: Element, name: string): Element | null =>
    childrenNamed(node, name)[0] ?? null;

const childText = (node: Element, name: string): string =>
    childNamed(node, name)?.textContent ?? '';

// ---- XML ----

export function looksLikeKeePassXml(text: string): boolean {
    return /<KeePassFile[\s>]/.test(text);
}

// Meta > Binaries holds every attachment once, keyed by the ID an entry's
// Binary element references. Compressed is set from the database's own
// compression setting, so both spellings turn up
function readBinaries(root: Document): Map<string, Uint8Array> {
    const binaries = new Map<string, Uint8Array>();
    const container = root.querySelector('KeePassFile > Meta > Binaries');
    for (const binary of container ? childrenNamed(container, 'Binary') : []) {
        const id = binary.getAttribute('ID');
        if (id === null) continue;
        let bytes: Uint8Array;
        try {
            bytes = Uint8Array.from(atob((binary.textContent ?? '').trim()), c => c.charCodeAt(0));
        } catch {
            continue;
        }
        if (binary.getAttribute('Compressed')?.toLowerCase() === 'true') {
            try {
                bytes = gunzipSync(bytes);
            } catch {
                // A binary that will not inflate is not one to attach
                continue;
            }
        }
        binaries.set(id, bytes);
    }
    return binaries;
}

// KDBX3 writes an ISO timestamp; KDBX4 writes seconds since year one, base64
// as a little-endian int64. Both turn up depending on the database's version
function readTime(raw: string): Date | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const iso = Date.parse(trimmed);
    if (Number.isFinite(iso)) return new Date(iso);
    try {
        const bytes = Uint8Array.from(atob(trimmed), c => c.charCodeAt(0));
        if (bytes.length < 8) return undefined;
        let seconds = 0n;
        for (let i = 7; i >= 0; i--) seconds = (seconds << 8n) | BigInt(bytes[i]);
        // 0001-01-01T00:00:00Z to the unix epoch. Finite is not the same as
        // representable: an int64 near its ceiling gives a finite count of
        // milliseconds that is still past the range a Date can hold, and an
        // Invalid Date on an entry makes the database refuse to serialize
        const at = new Date(Number(seconds) * 1000 - 62135596800000);
        return Number.isNaN(at.getTime()) ? undefined : at;
    } catch {
        return undefined;
    }
}

interface XmlEntryStrings {
    values: Map<string, string>;
    protectedKeys: Set<string>;
}

function readStrings(entry: Element): XmlEntryStrings {
    const values = new Map<string, string>();
    const protectedKeys = new Set<string>();
    for (const node of childrenNamed(entry, 'String')) {
        const key = childText(node, 'Key');
        if (!key) continue;
        const value = childNamed(node, 'Value');
        values.set(key, value?.textContent ?? '');
        // An export from an unlocked database is in the clear, but it still
        // records which fields the database protects
        if (value?.getAttribute('Protected')?.toLowerCase() === 'true'
            || value?.getAttribute('ProtectInMemory')?.toLowerCase() === 'true') {
            protectedKeys.add(key);
        }
    }
    return { values, protectedKeys };
}

function xmlEntry(entry: Element, group: string[] | undefined, binaries: Map<string, Uint8Array>): ImportedEntry | null {
    const { values, protectedKeys } = readStrings(entry);

    const customFields: NonNullable<ImportedEntry['customFields']> = [];
    let totp: string | undefined;
    const passkeyParts = new Map<string, string>();

    for (const [key, value] of values) {
        if (STANDARD.includes(key)) continue;
        if (!value) continue;
        // The one custom field the app owns: renaming it, as an unknown key
        // would be, would take the entry's one-time codes with it
        if (key === 'otp') { totp = value; continue; }
        if (Object.values(PASSKEY_KEYS).includes(key as never)) { passkeyParts.set(key, value); continue; }
        customFields.push({ key, value, protected: protectedKeys.has(key) });
    }

    // Attachments, by the id each Binary element references
    const attachments = childrenNamed(entry, 'Binary').flatMap(node => {
        const name = childText(node, 'Key');
        const ref = childNamed(node, 'Value')?.getAttribute('Ref');
        const data = ref === null || ref === undefined ? undefined : binaries.get(ref);
        return name && data ? [{ name, data }] : [];
    });

    // History holds whole past entries; only their passwords have anywhere
    // to go, and kdbx rebuilds the revisions from those
    const history = childrenNamed(childNamed(entry, 'History') ?? entry, 'Entry')
        .flatMap(past => {
            const password = readStrings(past).values.get('Password');
            if (!password) return [];
            const times = childNamed(past, 'Times');
            return [{ password, changed: times ? readTime(childText(times, 'LastModificationTime')) : undefined }];
        })
        .sort((a, b) => (a.changed?.getTime() ?? 0) - (b.changed?.getTime() ?? 0));

    const tags = childText(entry, 'Tags').split(/[;,]/).map(t => t.trim()).filter(Boolean);

    const credentialId = passkeyParts.get(PASSKEY_KEYS.credentialId);
    const privateKeyPem = passkeyParts.get(PASSKEY_KEYS.privateKeyPem);
    const relyingParty = passkeyParts.get(PASSKEY_KEYS.relyingParty);

    const title = values.get('Title') ?? '';
    const username = values.get('UserName') ?? '';
    const password = values.get('Password') ?? '';
    const url = values.get('URL') || undefined;
    const notes = values.get('Notes') || undefined;

    if (!title && !username && !password && !url && !notes && !totp
        && customFields.length === 0 && attachments.length === 0) {
        return null;
    }

    return {
        title: title || 'Untitled',
        username,
        password,
        url,
        notes,
        totp,
        group,
        tags: tags.length ? tags : undefined,
        customFields: customFields.length ? customFields : undefined,
        passwordHistory: history.length ? history : undefined,
        attachments: attachments.length ? attachments : undefined,
        passkey: credentialId && privateKeyPem && relyingParty
            ? {
                credentialId,
                privateKeyPem,
                relyingParty,
                username: passkeyParts.get(PASSKEY_KEYS.username) ?? '',
                userHandle: passkeyParts.get(PASSKEY_KEYS.userHandle) ?? '',
            }
            : undefined,
    };
}

export function parseKeePassXml(text: string): ImportedEntry[] {
    const doc = parseDocument(text);
    if (!doc) throw new Error('That XML file could not be read');
    const root = doc.querySelector('KeePassFile > Root > Group');
    if (!root) throw new Error('That XML file is not a KeePass export (no KeePassFile > Root > Group)');

    const binaries = readBinaries(doc);
    const entries: ImportedEntry[] = [];
    const recycleBin = doc.querySelector('KeePassFile > Meta > RecycleBinUUID')?.textContent?.trim();

    const walk = (group: Element, path: string[]) => {
        // Deleted entries are not ones to bring across
        if (recycleBin && childText(group, 'UUID').trim() === recycleBin) return;
        // Entry, not descendants: History holds Entry elements too
        for (const entry of childrenNamed(group, 'Entry')) {
            const imported = xmlEntry(entry, path.length ? path : undefined, binaries);
            if (imported) entries.push(imported);
        }
        for (const child of childrenNamed(group, 'Group')) {
            const name = childText(child, 'Name').trim();
            walk(child, name ? [...path, name] : path);
        }
    };
    // The root group's own name is the database's, not a folder anyone made
    walk(root, []);
    return entries;
}

// The printable report, told apart by the class names its stylesheet needs.
// Recognised only to refuse it by name; see the note in ImportService
export function looksLikeKeePassHtmlReport(text: string): boolean {
    return /<caption>/i.test(text) && /class="(username|password|notes|url|attr)"/i.test(text);
}

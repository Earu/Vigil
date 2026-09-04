import * as kdbxweb from 'kdbxweb';
import { Entry, Group } from '../types/database';
import { KeepassDatabaseService } from './KeepassDatabaseService';

// KeePass field references and placeholders, resolved the way KeePassXC
// resolves them (Entry::resolveReferencePlaceholderRecursive is the
// reference): {REF:<Wanted>@<SearchIn>:<Text>} finds the first entry whose
// SearchIn field contains Text (case-insensitive; UUIDs match exactly) and
// yields its Wanted field, itself resolved in the found entry's context.
// {TITLE}, {USERNAME}, {PASSWORD}, {URL}, {NOTES} and {S:Name} resolve
// against the entry they appear in. Unknown tokens pass through untouched:
// a password that happens to contain braces must come out exactly as stored.
//
// Two adapters feed the same resolver: the UI model (Entry/Group) and kdbx
// objects (browser integration hands out logins straight from the kdbx).
// Both skip the recycle bin, so a reference into deleted material fails the
// same way everywhere instead of autofilling what the UI says is gone.

const MAX_DEPTH = 10;
// Depth alone does not bound the work: a field holding k references to
// itself expands to k^MAX_DEPTH resolutions, and a shared vault can carry
// such a field. Each top-level resolve gets this many token resolutions;
// past it, tokens are left as their text. Real vaults use a handful
const MAX_TOKENS = 500;
interface Budget { left: number }

type FieldCode = 'T' | 'U' | 'P' | 'A' | 'N';

interface RefEntryView {
    field(code: FieldCode): string;
    custom(name: string): string | undefined;
    customValues(): string[];
    hexId(): string;
}

interface RefSource {
    self: RefEntryView;
    all(): Iterable<RefEntryView>;
}

const LOCAL_PLACEHOLDERS: Record<string, FieldCode> = {
    TITLE: 'T', USERNAME: 'U', PASSWORD: 'P', URL: 'A', NOTES: 'N',
};

// KeePass {REF:...@I:...} carries uuids as bare hex; kdbxweb ids are base64.
// Exported so the browser protocol's uuid hex (BrowserIntegrationService)
// and reference matching stay one implementation
export function uuidBase64ToHex(base64Uuid: string): string {
    try {
        return [...kdbxweb.ByteUtils.base64ToBytes(base64Uuid)]
            .map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return '';
    }
}

function fieldText(value: string | kdbxweb.ProtectedValue | undefined): string {
    return value === undefined ? '' : KeepassDatabaseService.getFieldString(value);
}

function modelView(entry: Entry): RefEntryView {
    return {
        field: (code) => {
            switch (code) {
                case 'T': return entry.title;
                case 'U': return entry.username;
                case 'P': return KeepassDatabaseService.getPasswordString(entry.password);
                case 'A': return entry.url ?? '';
                case 'N': return entry.notes ?? '';
            }
        },
        custom: (name) => {
            const lower = name.toLowerCase();
            const match = (entry.customFields ?? []).find(f => f.key.toLowerCase() === lower);
            return match ? fieldText(match.value) : undefined;
        },
        customValues: () => (entry.customFields ?? []).map(f => fieldText(f.value)),
        hexId: () => uuidBase64ToHex(entry.id),
    };
}

const KDBX_FIELD_NAMES: Record<FieldCode, string> = {
    T: 'Title', U: 'UserName', P: 'Password', A: 'URL', N: 'Notes',
};

const KDBX_STANDARD = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

function kdbxView(entry: kdbxweb.KdbxEntry): RefEntryView {
    return {
        field: (code) => fieldText(entry.fields.get(KDBX_FIELD_NAMES[code])),
        custom: (name) => {
            const lower = name.toLowerCase();
            for (const [key, value] of entry.fields) {
                if (!KDBX_STANDARD.includes(key) && key.toLowerCase() === lower) {
                    return fieldText(value);
                }
            }
            return undefined;
        },
        customValues: () => [...entry.fields]
            .filter(([key]) => !KDBX_STANDARD.includes(key))
            .map(([, value]) => fieldText(value)),
        hexId: () => uuidBase64ToHex(entry.uuid.id),
    };
}

function* kdbxEntries(group: kdbxweb.KdbxGroup, recycleBinUuid?: string): Generator<kdbxweb.KdbxEntry> {
    if (recycleBinUuid && group.uuid.id === recycleBinUuid) return;
    for (const entry of group.entries) yield entry;
    for (const child of group.groups) yield* kdbxEntries(child, recycleBinUuid);
}

// {REF:T@I:...} parts; both codes and the text are matched case-insensitively
const REF_PATTERN = /^REF:([TUPANI])@([TUPANIO]):(.+)$/i;

function searchMatches(view: RefEntryView, searchIn: string, text: string): boolean {
    const needle = text.toLowerCase();
    if (searchIn === 'I') return view.hexId().toLowerCase() === needle;
    if (searchIn === 'O') return view.customValues().some(v => v.toLowerCase().includes(needle));
    return view.field(searchIn as FieldCode).toLowerCase().includes(needle);
}

function resolveToken(token: string, source: RefSource, depth: number, budget: Budget): string | undefined {
    if (budget.left <= 0) return undefined;
    budget.left--;
    const inner = token.slice(1, -1);
    const upper = inner.toUpperCase();

    const local = LOCAL_PLACEHOLDERS[upper];
    if (local) {
        return resolveIn(source.self.field(local), source, depth + 1, budget);
    }

    if (upper.startsWith('S:')) {
        const value = source.self.custom(inner.slice(2));
        return value === undefined ? undefined : resolveIn(value, source, depth + 1, budget);
    }

    const ref = REF_PATTERN.exec(inner);
    if (ref) {
        const wanted = ref[1].toUpperCase();
        const searchIn = ref[2].toUpperCase();
        const text = ref[3];
        for (const candidate of source.all()) {
            if (!searchMatches(candidate, searchIn, text)) continue;
            const value = wanted === 'I'
                ? candidate.hexId().toUpperCase()
                : candidate.field(wanted as FieldCode);
            // Resolved in the found entry's context: its own placeholders
            // refer to its fields, and it may reference onward in turn
            return resolveIn(value, { self: candidate, all: source.all }, depth + 1, budget);
        }
        return undefined;
    }

    return undefined;
}

function resolveIn(text: string, source: RefSource, depth: number, budget: Budget): string {
    if (depth > MAX_DEPTH || !text.includes('{')) return text;

    let result = '';
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf('{', i);
        if (open === -1) {
            result += text.slice(i);
            break;
        }
        result += text.slice(i, open);

        // KeePass brace escapes come first: their bodies contain braces and
        // would otherwise confuse the token scan
        if (text.startsWith('{{}', open)) {
            result += '{';
            i = open + 3;
            continue;
        }
        if (text.startsWith('{}}', open)) {
            result += '}';
            i = open + 3;
            continue;
        }

        const close = text.indexOf('}', open + 1);
        if (close === -1) {
            result += text.slice(open);
            break;
        }

        const token = text.slice(open, close + 1);
        const resolved = resolveToken(token, source, depth, budget);
        result += resolved ?? token;
        i = close + 1;
    }
    return result;
}

export class PlaceholderService {
    // The open vault's model root, registered by PasswordView for as long
    // as a vault is on screen. Display surfaces resolve through
    // displayField without threading the database down their prop chains,
    // which is how earlier surfaces ended up showing raw tokens: opting in
    // was manual. Cleared on lock so no decrypted model outlives its view
    private static registeredRoot: Group | null = null;

    static setModelRoot(root: Group | null): void {
        this.registeredRoot = root;
    }

    static getModelRoot(): Group | null {
        return this.registeredRoot;
    }

    // Whether the text contains a {REF:...} token at all: such a password is
    // a pointer, so hashing or scoring its literal text says nothing
    private static readonly REF_TOKEN = /\{REF:[TUPANI]@[TUPANIO]:/i;

    static hasReference(text: string | undefined): boolean {
        return !!text && this.REF_TOKEN.test(text);
    }

    // A password that IS a single reference (the normal authored shape), for
    // the security report: the entry it ultimately points at carries the
    // verdict, and this follows password-to-password chains to find it.
    // Composite passwords mixing a reference with literal text resolve to a
    // value no other entry holds, so they get no target and no verdict
    private static readonly WHOLE_PASSWORD_REF = /^\s*\{REF:P@([TUPANIO]):(.+)\}\s*$/i;

    static findPasswordTargetEntry(entry: Entry, root: Group): Entry | null {
        const visited = new Set<string>([entry.id]);
        let current = entry;
        for (let depth = 0; depth < MAX_DEPTH; depth++) {
            const text = KeepassDatabaseService.getPasswordString(current.password);
            const ref = this.WHOLE_PASSWORD_REF.exec(text);
            if (!ref) return depth === 0 ? null : current;
            const searchIn = ref[1].toUpperCase();
            const needle = ref[2];
            let next: Entry | null = null;
            for (const candidate of KeepassDatabaseService.getAllEntriesFromGroup(root)) {
                if (searchMatches(modelView(candidate), searchIn, needle)) {
                    next = candidate;
                    break;
                }
            }
            if (!next || visited.has(next.id)) return null;
            visited.add(next.id);
            current = next;
        }
        return null;
    }

    // The default accessor for entry text anywhere in the UI: resolved
    // against the open vault, raw when none is registered (locked, tests)
    static displayField(text: string | undefined, entry: Entry): string {
        if (!text) return '';
        return this.registeredRoot ? this.resolveModel(text, entry, this.registeredRoot) : text;
    }

    // Resolution over the model is memoized per model build: the entry list
    // re-renders on every scroll tick and each {REF:...} is a linear scan of
    // the vault, so uncached rows would pay that scan per frame. The root
    // object's identity changes with every convert, which is exactly the
    // lifetime of a resolved value
    private static modelCache = new WeakMap<Group, Map<string, string>>();

    static resolveModel(text: string, entry: Entry, root: Group): string {
        if (!text.includes('{')) return text;

        let cache = this.modelCache.get(root);
        if (!cache) {
            cache = new Map();
            this.modelCache.set(root, cache);
        }
        const key = `${entry.id} ${text}`;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;

        const all = function* () {
            for (const e of KeepassDatabaseService.getAllEntriesFromGroup(root)) yield modelView(e);
        };
        const result = resolveIn(text, { self: modelView(entry), all }, 0, { left: MAX_TOKENS });
        cache.set(key, result);
        return result;
    }

    static resolveKdbx(text: string, entry: kdbxweb.KdbxEntry, root: kdbxweb.KdbxGroup, recycleBinUuid?: string): string {
        if (!text.includes('{')) return text;
        const all = function* () {
            for (const e of kdbxEntries(root, recycleBinUuid)) yield kdbxView(e);
        };
        return resolveIn(text, { self: kdbxView(entry), all }, 0, { left: MAX_TOKENS });
    }
}

// Search matches what the user sees; the hook assignment (rather than an
// import in KeepassDatabaseService) keeps the two modules from importing
// each other
KeepassDatabaseService.displayResolver = (text, entry) => PlaceholderService.displayField(text, entry);

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as kdbxweb from 'kdbxweb';
import { PlaceholderService } from '../../src/services/PlaceholderService';
import { Entry, Group } from '../../src/types/database';
import { settings, anyText, withinMs } from './fuzz';

// {REF:...} and {TITLE}-style placeholders are resolved on every render and
// on every browser request, over text that came from the vault, which can
// have come from anyone. A field that references itself, a ring of entries
// referencing each other, or a token in any broken shape must resolve to
// some string quickly rather than recurse forever or throw

const uuid = () => kdbxweb.KdbxUuid.random().toString();
const hex = (id: string) => [...kdbxweb.ByteUtils.base64ToBytes(id)].map(b => b.toString(16).padStart(2, '0')).join('');

const fieldCode = fc.constantFrom('T', 'U', 'P', 'A', 'N', 'I');
const searchCode = fc.constantFrom('T', 'U', 'P', 'A', 'N', 'I', 'O');
const local = fc.constantFrom('{TITLE}', '{USERNAME}', '{PASSWORD}', '{URL}', '{NOTES}', '{title}', '{REF:', '{REF:}', '{REF:X@Y:z}', '{REF:T@I:notahexid}', '{{TITLE}}', '{REF:T@T:{TITLE}}');

// A ring of entries whose fields point at each other by id and by title
function vault(count: number, texts: string[]): { root: Group; entries: Entry[] } {
    const ids = Array.from({ length: count }, uuid);
    const entries: Entry[] = ids.map((id, i) => {
        const next = ids[(i + 1) % count];
        const pick = (k: number) => texts[(i * 5 + k) % texts.length] ?? '';
        return {
            id,
            title: `E${i} ${pick(0)}`,
            username: pick(1).replace(/%id%/g, hex(next)),
            password: pick(2).replace(/%id%/g, hex(next)),
            url: pick(3).replace(/%id%/g, hex(next)),
            notes: pick(4).replace(/%id%/g, hex(id)),
            customFields: [{ key: pick(0) || 'k', value: pick(1).replace(/%id%/g, hex(next)), protected: false }],
            tags: [],
            attachments: [],
            history: [],
            created: new Date(0),
            modified: new Date(0),
            expires: false,
        };
    });
    const root: Group = { id: uuid(), name: 'root', groups: [{ id: uuid(), name: 'sub', groups: [], entries: entries.slice(1) }], entries: entries.slice(0, 1) };
    return { root, entries };
}

// Reference tokens that target the ring: by id (%id% is filled in per entry)
// and by title, in every field and search code, plus broken shapes
const token = fc.oneof(
    fc.tuple(fieldCode, searchCode).map(([f, s]) => `{REF:${f}@${s}:${s === 'I' ? '%id%' : 'E'}}`),
    fc.tuple(fieldCode, searchCode, anyText()).map(([f, s, v]) => `{REF:${f}@${s}:${v}}`),
    local,
    anyText(),
);
const text = fc.array(token, { maxLength: 4 }).map(parts => parts.join(' '));

describe('placeholder resolution under fuzz', () => {
    it('resolves any text in any ring of entries to a string, quickly', async () => {
        await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.array(text, { minLength: 1, maxLength: 10 }), text, async (count, texts, probe) => {
            const { root, entries } = vault(count, texts);
            await withinMs(300, () => {
                for (const entry of entries) {
                    for (const field of [entry.title, entry.username, entry.password as string, entry.url ?? '', entry.notes ?? '', probe]) {
                        expect(typeof PlaceholderService.resolveModel(field, entry, root)).toBe('string');
                        expect(typeof PlaceholderService.displayField(field, entry)).toBe('string');
                        expect(typeof PlaceholderService.hasReference(field)).toBe('boolean');
                    }
                    expect(() => PlaceholderService.findPasswordTargetEntry(entry, root)).not.toThrow();
                }
            });
        }), settings());
    });

    it('text without a brace is returned unchanged', () => {
        fc.assert(fc.property(anyText().filter(t => !t.includes('{')), (plain) => {
            const { root, entries } = vault(2, ['a']);
            expect(PlaceholderService.resolveModel(plain, entries[0], root)).toBe(plain);
            expect(PlaceholderService.hasReference(plain)).toBe(false);
        }), settings());
    });

    it('a resolved reference by id yields the target field, and a self reference terminates', () => {
        fc.assert(fc.property(fieldCode, anyText().filter(t => !t.includes('{')), (code, value) => {
            const { root, entries } = vault(2, [value]);
            const target = entries[1];
            // KeePass renders a referenced UUID as uppercase hex
            const expected: Record<string, string> = { T: target.title, U: target.username, P: target.password as string, A: target.url ?? '', N: target.notes ?? '', I: hex(target.id).toUpperCase() };
            const resolved = PlaceholderService.resolveModel(`{REF:${code}@I:${hex(target.id)}}`, entries[0], root);
            expect(resolved).toBe(code === 'T' || code === 'I' ? expected[code] : PlaceholderService.resolveModel(expected[code], target, root));
            const self = `{REF:${code}@I:${hex(entries[0].id)}}`;
            expect(typeof PlaceholderService.resolveModel(self, { ...entries[0], username: self }, root)).toBe('string');
        }), settings());
    });

    it('the kdbx resolver agrees with the model resolver on the same vault', () => {
        fc.assert(fc.property(fc.array(text, { minLength: 1, maxLength: 6 }), (texts) => {
            const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('x')), 'v');
            const { root, entries } = vault(3, texts);
            const kdbxEntries = entries.map(e => {
                const k = db.createEntry(db.getDefaultGroup());
                k.uuid = new kdbxweb.KdbxUuid(e.id);
                k.fields.set('Title', e.title);
                k.fields.set('UserName', e.username);
                k.fields.set('Password', kdbxweb.ProtectedValue.fromString(e.password as string));
                k.fields.set('URL', e.url ?? '');
                k.fields.set('Notes', e.notes ?? '');
                for (const field of e.customFields ?? []) k.fields.set(field.key, field.value as string);
                return k;
            });
            for (let i = 0; i < entries.length; i++) {
                const model = PlaceholderService.resolveModel(entries[i].username, entries[i], root);
                const kdbx = PlaceholderService.resolveKdbx(entries[i].username, kdbxEntries[i], db.getDefaultGroup());
                expect(kdbx).toBe(model);
            }
        }), settings());
    });
});

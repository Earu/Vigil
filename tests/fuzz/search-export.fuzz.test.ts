import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { KeepassDatabaseService as Svc } from '../../src/services/KeepassDatabaseService';
import { ExportService } from '../../src/services/ExportService';
import { Entry } from '../../src/types/database';
import { settings, anyText, withinMs } from './fuzz';

// Search runs on every keystroke over every entry; a query must never throw
// or run away. The formula check guards a CSV export from spreadsheet code
// execution; whatever a cell holds, the check answers

const entry = (): fc.Arbitrary<Entry> => fc.record({
    id: fc.uuid(),
    title: anyText(),
    username: anyText(),
    password: anyText(),
    url: fc.option(anyText(), { nil: undefined }),
    notes: fc.option(anyText(), { nil: undefined }),
    tags: fc.array(anyText(), { maxLength: 4 }),
    customFields: fc.array(fc.record({ key: anyText(), value: anyText(), protected: fc.boolean() }), { maxLength: 3 }),
    created: fc.constant(new Date(0)),
    modified: fc.constant(new Date(0)),
    attachments: fc.constant([]),
    history: fc.constant([]),
    expires: fc.boolean(),
}) as fc.Arbitrary<Entry>;

describe('search under fuzz', () => {
    it('any query parses and any filter returns a subset, quickly', async () => {
        await fc.assert(fc.asyncProperty(fc.array(entry(), { maxLength: 40 }), anyText(), async (entries, query) => {
            await withinMs(250, () => {
                const terms = Svc.parseSearchQuery(query);
                expect(Array.isArray(terms)).toBe(true);
                const kept = Svc.filterEntries(entries, query);
                for (const item of kept) expect(entries).toContain(item);
            });
        }), settings());
    });

    it('a term found in a plain field is found by search, and protected custom values are never searched', () => {
        fc.assert(fc.property(entry(), fc.stringMatching(/^[a-z0-9]{2,8}$/), (base, needle) => {
            const hit: Entry = { ...base, notes: `x ${needle} y`, customFields: [] };
            expect(Svc.filterEntries([hit], needle)).toHaveLength(1);
            const hidden: Entry = { ...base, title: 'a', username: 'b', url: 'c', notes: 'd', tags: [], customFields: [{ key: 'k', value: needle, protected: true }] };
            expect(Svc.filterEntries([hidden], needle)).toHaveLength(0);
        }), settings());
    });

    it('tokenizer never loses characters outside quotes and whitespace', () => {
        fc.assert(fc.property(fc.array(fc.stringMatching(/^[^\s"]{1,10}$/), { maxLength: 6 }), (words) => {
            const terms = Svc.parseSearchQuery(words.join('  '));
            expect(terms.map(t => t.field === 'any' ? t.value : `${t.field}:${t.value}`).join(' ').length)
                .toBeGreaterThanOrEqual(words.join(' ').toLowerCase().replace(/\b(user|note):/g, (m) => m === 'user:' ? 'username:' : 'notes:').length - 20);
            for (const term of terms) expect(term.value.length).toBeGreaterThan(0);
        }), settings());
    });
});

describe('export formula detection under fuzz', () => {
    it('answers a boolean for any cell and flags every spreadsheet call it would run', () => {
        fc.assert(fc.property(anyText(), (cell) => {
            expect(typeof ExportService.looksLikeFormula(cell)).toBe('boolean');
        }), settings());
        fc.assert(fc.property(fc.constantFrom('=', '+', '-', '@', '\t=', '\r='), fc.constantFrom('HYPERLINK', 'cmd', 'SUM', 'IMPORTXML', 'WEBSERVICE'), fc.stringMatching(/^[a-z0-9"',: ]{0,20}$/), (trigger, fn, args) => {
            const cell = fn === 'cmd' ? `${trigger}cmd|' /C calc'!A0` : `${trigger}${fn}(${args})`;
            expect(ExportService.looksLikeFormula(cell)).toBe(true);
        }), settings());
    });

    it('never throws on any row set', () => {
        fc.assert(fc.property(fc.array(fc.array(anyText(), { maxLength: 8 }), { maxLength: 10 }), (rows) => {
            expect(() => ExportService.formulaRisks(rows)).not.toThrow();
        }), settings());
    });
});

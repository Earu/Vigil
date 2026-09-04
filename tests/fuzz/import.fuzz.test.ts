import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ImportService } from '../../src/services/ImportService';
import { settings, anyText, anyValue, withinMs } from './fuzz';

// Import files come from other password managers, which means from other
// people's export bugs and from whatever a user renamed to .csv. The
// parsers answer a result or a plain Error; they never hang, never throw
// anything else, and never fabricate entries out of nothing

const csvCell = fc.oneof(anyText(), fc.stringMatching(/^[A-Za-z0-9 ,"\n]{0,20}$/));
const csvText = fc.array(fc.array(csvCell, { minLength: 1, maxLength: 8 }), { maxLength: 12 })
    .map(rows => rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n'));

const headerSets = fc.constantFrom(
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
    'url,username,password,totp,extra,name,grouping,fav',
    'Group,Title,Username,Password,URL,Notes,TOTP,Icon,Last Modified,Created',
    'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes',
    'title,username,password,url,notes',
    anyText,
);
const shapedCsv = fc.tuple(headerSets, csvText).map(([h, body]) => `${typeof h === 'string' ? h : ''}\n${body}`);

const bitwardenJson = fc.record({
    encrypted: fc.oneof(fc.boolean(), anyValue()),
    folders: fc.oneof(fc.array(fc.record({ id: anyText(), name: anyText() })), anyValue()),
    items: fc.oneof(fc.array(fc.record({
        type: fc.oneof(fc.constantFrom(1, 2, 3, 4), anyValue()),
        name: anyText(),
        notes: fc.oneof(anyText(), fc.constant(null)),
        folderId: fc.oneof(anyText(), fc.constant(null)),
        login: fc.oneof(fc.record({ username: anyText(), password: anyText(), totp: anyText(), uris: fc.oneof(fc.array(fc.record({ uri: anyText() })), anyValue()) }), anyValue()),
        fields: fc.oneof(fc.array(fc.record({ name: anyText(), value: anyText(), type: fc.integer() })), anyValue()),
    }, { requiredKeys: [] })), anyValue()),
}, { requiredKeys: [] }).map(v => JSON.stringify(v));

const file = (name: string, text: string) => new File([text], name, { type: 'text/plain' });

describe('import parsing under fuzz', () => {
    it('parseCsv answers a table for any text, quickly', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(anyText(), csvText), async (text) => {
            await withinMs(300, () => {
                const rows = ImportService.parseCsv(text);
                expect(Array.isArray(rows)).toBe(true);
                for (const row of rows) for (const cell of row) expect(typeof cell).toBe('string');
            });
        }), settings());
    });

    it('a quoted table survives the round trip through parseCsv', () => {
        fc.assert(fc.property(fc.array(fc.array(anyText(), { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 }), (rows) => {
            fc.pre(rows.every(r => r.length === rows[0].length));
            const text = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
            // A row of empty cells is what a blank line parses to, and the
            // parser drops those; they are dropped from both sides
            const blank = (r: string[]) => r.every(c => c === '');
            const parsed = ImportService.parseCsv(text).filter(r => !blank(r));
            expect(parsed.map(r => r.map(c => c.replace(/\r\n/g, '\n'))))
                .toEqual(rows.filter(r => !blank(r)).map(r => r.map(c => c.replace(/\r\n/g, '\n'))));
        }), settings());
    });

    it('parseFile resolves a result or rejects with an Error for any csv or json', async () => {
        await fc.assert(fc.asyncProperty(
            fc.oneof(
                shapedCsv.map(t => ['a.csv', t] as const),
                bitwardenJson.map(t => ['b.json', t] as const),
                anyText().map(t => ['c.json', t] as const),
                anyText().map(t => ['d.csv', t] as const),
            ),
            async ([name, text]) => {
                await withinMs(500, async () => {
                    try {
                        const result = await ImportService.parseFile(file(name, text));
                        expect(Array.isArray(result.entries)).toBe(true);
                        expect(typeof result.skipped).toBe('number');
                        for (const item of result.entries) expect(typeof item.title).toBe('string');
                    } catch (error) {
                        expect(error).toBeInstanceOf(Error);
                    }
                });
            }), settings());
    });
});

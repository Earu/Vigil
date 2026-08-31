import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { ImportService } = await import('../src/services/ImportService');
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const fileOf = (name: string, content: string) => new File([content], name);

describe('csv tokenizer', () => {
    it('handles quoted commas, escaped quotes and embedded newlines', () => {
        const rows = ImportService.parseCsv('a,"b,c","d""e","line1\nline2"\r\nf,g,h,i\n');
        expect(rows).toEqual([
            ['a', 'b,c', 'd"e', 'line1\nline2'],
            ['f', 'g', 'h', 'i'],
        ]);
    });
});

describe('format detection and parsing', () => {
    it('parses a Bitwarden JSON export with folders, totp and custom fields', async () => {
        const json = JSON.stringify({
            encrypted: false,
            folders: [{ id: 'f1', name: 'Work/Mail' }],
            items: [
                {
                    type: 1, name: 'GitHub', folderId: 'f1', notes: 'the note',
                    login: {
                        username: 'octo', password: 'hub-pass',
                        uris: [{ uri: 'https://github.com' }],
                        totp: 'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
                    },
                    fields: [
                        { name: 'PIN', value: '1234', type: 0 },
                        { name: 'Recovery', value: 'shh', type: 1 },
                        { name: 'Linked', value: null, type: 3 },
                    ],
                },
                { type: 2, name: 'A note', notes: 'just text', secureNote: {} },
                { type: 3, name: 'A card' },
            ],
        });
        const result = await ImportService.parseFile(fileOf('export.json', json));
        expect(result.source).toBe('Bitwarden');
        expect(result.skipped).toBe(1);
        expect(result.entries).toHaveLength(2);

        const gh = result.entries[0];
        expect(gh.title).toBe('GitHub');
        expect(gh.username).toBe('octo');
        expect(gh.url).toBe('https://github.com');
        expect(gh.group).toEqual(['Work', 'Mail']);
        expect(gh.totp).toContain('otpauth://');
        expect(gh.customFields).toEqual([
            { key: 'PIN', value: '1234', protected: false },
            { key: 'Recovery', value: 'shh', protected: true },
        ]);
    });

    it('rejects an encrypted Bitwarden export', async () => {
        const json = JSON.stringify({ encrypted: true, items: [] });
        await expect(ImportService.parseFile(fileOf('export.json', json))).rejects.toThrow(/encrypted/);
    });

    it('parses a Bitwarden CSV export', async () => {
        const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
            + 'Social,0,login,Twitter,,,0,https://twitter.com,tw-user,tw-pass,\n'
            + ',0,card,Visa,,,0,,,,\n';
        const result = await ImportService.parseFile(fileOf('export.csv', csv));
        expect(result.source).toBe('Bitwarden');
        expect(result.skipped).toBe(1);
        expect(result.entries[0]).toMatchObject({
            title: 'Twitter', username: 'tw-user', password: 'tw-pass',
            url: 'https://twitter.com', group: ['Social'],
        });
    });

    it('parses a LastPass CSV with multiline notes and nested folders', async () => {
        const csv = 'url,username,password,totp,extra,name,grouping,fav\n'
            + 'https://example.com,user,pass,GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ,"line1\nline2",Example,Personal\\Banking,0\n'
            + 'http://sn,,,,"secret text",My Note,,0\n';
        const result = await ImportService.parseFile(fileOf('lastpass.csv', csv));
        expect(result.source).toBe('LastPass');
        expect(result.entries[0]).toMatchObject({
            title: 'Example', notes: 'line1\nline2', group: ['Personal', 'Banking'],
        });
        expect(result.entries[0].totp).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        // secure note: no URL
        expect(result.entries[1].url).toBeUndefined();
        expect(result.entries[1].notes).toBe('secret text');
    });

    it('parses a 1Password CSV export', async () => {
        const csv = 'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n'
            + 'Mail,https://mail.example,me@x.com,mail-pass,otpauth://totp/Mail?secret=GEZDGNBV,,false,,note here\n';
        const result = await ImportService.parseFile(fileOf('1password.csv', csv));
        expect(result.source).toBe('1Password');
        expect(result.entries[0]).toMatchObject({
            title: 'Mail', username: 'me@x.com', password: 'mail-pass',
            totp: 'otpauth://totp/Mail?secret=GEZDGNBV', notes: 'note here',
        });
    });

    it('parses a Chrome-style generic CSV', async () => {
        const csv = 'name,url,username,password\n'
            + 'example.com,https://example.com,me,pw123\n'
            + 'no-password.com,https://x.com,me,\n';
        const result = await ImportService.parseFile(fileOf('chrome.csv', csv));
        expect(result.source).toBe('CSV');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].title).toBe('example.com');
    });

    it('rejects unusable files', async () => {
        await expect(ImportService.parseFile(fileOf('x.json', 'not json'))).rejects.toThrow(/JSON/);
        await expect(ImportService.parseFile(fileOf('x.csv', 'just,one,line'))).rejects.toThrow(/no entries/);
        await expect(ImportService.parseFile(fileOf('x.csv', 'a,b\n1,2\n'))).rejects.toThrow(/columns/);
    });
});

describe('writing into the database', () => {
    it('creates nested groups, protected totp and custom fields, then round-trips', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

        const result = await ImportService.parseFile(fileOf('export.json', JSON.stringify({
            folders: [{ id: 'f1', name: 'Work' }],
            items: [
                {
                    type: 1, name: 'GitHub', folderId: 'f1',
                    login: {
                        username: 'octo', password: 'hub-pass',
                        uris: [{ uri: 'https://github.com' }],
                        totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', // bare secret
                    },
                    fields: [{ name: 'Recovery', value: 'shh', type: 1 }],
                },
                { type: 1, name: 'RootEntry', login: { username: 'a', password: 'b' } },
            ],
        })));

        const count = await ImportService.importToDatabase(result, kdbxDb);
        expect(count).toBe(2);

        const reloaded = await loadSaved(env);
        const imported = reloaded.getDefaultGroup().groups.find(g => g.name === 'Imported (Bitwarden)')!;
        expect(imported).toBeDefined();
        expect(imported.entries.map(e => e.fields.get('Title'))).toContain('RootEntry');

        const work = imported.groups.find(g => g.name === 'Work')!;
        const gh = work.entries[0];
        expect(gh.fields.get('Title')).toBe('GitHub');
        const otp = gh.fields.get('otp');
        expect(otp).toBeInstanceOf(kdbxweb.ProtectedValue);
        // bare secret was normalized into an otpauth URI
        expect((otp as kdbxweb.ProtectedValue).getText()).toMatch(/^otpauth:\/\/totp\//);
        const recovery = gh.fields.get('Recovery');
        expect(recovery).toBeInstanceOf(kdbxweb.ProtectedValue);

        // the model reads the TOTP config back
        const database = Svc.convertKdbxToDatabase(reloaded);
        const workGroup = database.root.groups.find(g => g.name === 'Imported (Bitwarden)')!.groups[0];
        const { TotpService } = await import('../src/services/TotpService');
        expect(TotpService.getConfig(workGroup.entries[0].customFields)).not.toBeNull();
    });
});

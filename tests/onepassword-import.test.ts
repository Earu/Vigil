import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { zipSync, strToU8 } from 'fflate';
import { installMockWindow, cred, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { ImportService } = await import('../src/services/ImportService');
const { parse1Pux } = await import('../src/services/OnePasswordImport');

// 1Password's own export dialog produces these two, and its CSV carries
// logins only by 1Password's own documentation. Field names follow
// bitwarden/clients libs/importer/src/importers/onepassword, which is the
// maintained reading of both formats.
const PIF_SEPARATOR = '***5642bee8-a5ff-11dc-8314-0800200c9a66***';

const puxFile = (data: unknown, extra: Record<string, Uint8Array> = {}) =>
    new File([zipSync({ 'export.data': strToU8(JSON.stringify(data)), ...extra })], 'export.1pux');

describe('1Password .1pux', () => {
    const archive = {
        accounts: [{
            attrs: { name: 'Me' },
            vaults: [
                {
                    attrs: { name: 'Private' },
                    items: [
                        {
                            uuid: 'a', state: 'active', categoryUuid: '001',
                            overview: {
                                title: 'GitHub', url: 'https://github.com',
                                urls: [{ url: 'https://github.com' }, { url: 'https://gist.github.com' }],
                                tags: ['dev', 'work'],
                            },
                            details: {
                                loginFields: [
                                    { value: 'octo', name: 'username', fieldType: 'T', designation: 'username' },
                                    { value: 'pw', name: 'password', fieldType: 'P', designation: 'password' },
                                ],
                                notesPlain: 'a note',
                                sections: [{
                                    title: 'Security', fields: [
                                        { title: 'one-time password', id: 'TOTP_abc', value: { totp: 'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQ' } },
                                        { title: 'PIN', id: 'pin', value: { concealed: '1234' } },
                                        { title: 'Renews', id: 'd', value: { date: 1700000000 } },
                                    ],
                                }],
                                passwordHistory: [{ value: 'newer', time: 1690000000 }, { value: 'older', time: 1600000000 }],
                            },
                        },
                        {
                            uuid: 'b', state: 'active', categoryUuid: '114',
                            overview: { title: 'deploy key' },
                            details: {
                                sections: [{
                                    title: '', fields: [{
                                        title: 'private key', id: 'private_key',
                                        value: {
                                            sshKey: {
                                                privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
                                                metadata: { publicKey: 'ssh-ed25519 AAAAC3 me@host', keyType: 'ed25519' },
                                            },
                                        },
                                    }],
                                }],
                            },
                        },
                        // A Password-category item has no login fields at all
                        {
                            uuid: 'c', state: 'archived', categoryUuid: '005',
                            overview: { title: 'Just a password' }, details: { password: 'standalone' },
                        },
                    ],
                },
                {
                    attrs: { name: 'Shared' },
                    items: [{
                        uuid: 'e', state: 'active', categoryUuid: '003',
                        overview: { title: 'Wifi' }, details: { notesPlain: 'the passphrase' },
                    }],
                },
            ],
        }],
    };

    it('reads a login with its codes, URLs, tags, fields and history', async () => {
        const result = await ImportService.parseFile(puxFile(archive));
        expect(result.source).toBe('1Password');
        const gh = result.entries.find(e => e.title === 'GitHub')!;
        expect(gh).toMatchObject({
            username: 'octo', password: 'pw',
            url: 'https://github.com',
            extraUrls: ['https://gist.github.com'],
            totp: 'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQ',
            notes: 'a note',
            tags: ['dev', 'work'],
            group: ['Private'],
        });
        // Concealed section fields stay concealed, and a date is spelled out
        // rather than left as the seconds 1Password stores
        expect(gh.customFields).toEqual([
            { key: 'Security / PIN', value: '1234', protected: true },
            { key: 'Security / Renews', value: '2023-11-14', protected: false },
        ]);
        // newest first in the file, oldest first on the way in
        expect(gh.passwordHistory?.map(h => h.password)).toEqual(['older', 'newer']);
    });

    it('makes each vault a group', async () => {
        const result = await ImportService.parseFile(puxFile(archive));
        expect(result.entries.find(e => e.title === 'Wifi')?.group).toEqual(['Shared']);
        expect(result.entries.find(e => e.title === 'GitHub')?.group).toEqual(['Private']);
    });

    it('takes an SSH key item and a bare password item', async () => {
        const result = await ImportService.parseFile(puxFile(archive));
        expect(result.entries.find(e => e.title === 'deploy key')?.sshKey).toMatchObject({
            fileName: 'deploy key.key',
            publicKey: 'ssh-ed25519 AAAAC3 me@host',
        });
        // categoryUuid 005 keeps its secret in details.password
        expect(result.entries.find(e => e.title === 'Just a password')?.password).toBe('standalone');
    });

    it('is recognised by its zip header whatever it is called', async () => {
        const renamed = new File([await puxFile(archive).arrayBuffer()], 'export.dat');
        expect((await ImportService.parseFile(renamed)).source).toBe('1Password');
    });

    it('writes through to a database', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        const result = await ImportService.parseFile(puxFile(archive));
        await ImportService.writeEntries(result, db);
        const root = db.getDefaultGroup().groups.find(g => g.name === 'Imported (1Password)')!;
        expect(root.groups.map(g => g.name).sort()).toEqual(['Private', 'Shared']);
        const key = root.groups.find(g => g.name === 'Private')!.entries.find(e => e.fields.get('Title') === 'deploy key')!;
        expect([...key.binaries.keys()].sort()).toEqual(['KeeAgent.settings', 'deploy key.key', 'deploy key.key.pub']);
    });

    it('says what is wrong with an archive it cannot read', async () => {
        await expect(ImportService.parseFile(new File([zipSync({ 'other.txt': strToU8('x') })], 'x.1pux')))
            .rejects.toThrow(/no export.data/);
        await expect(ImportService.parseFile(new File([zipSync({ 'export.data': strToU8('not json') })], 'x.1pux')))
            .rejects.toThrow(/not valid JSON/);
    });

    // A zip names what each file unpacks to, and a highly compressible one
    // names far more than it costs to send. Unbounded that is the renderer,
    // and any unsaved edit, gone on a file the user was only importing.
    // The bound is passed in so this needs no real bomb to exercise it
    it('refuses an archive that unpacks to more than it will read', () => {
        const bytes = zipSync({
            'export.data': strToU8(JSON.stringify(archive)),
            'files/doc___big.pdf': strToU8('x'.repeat(4096)),
        });
        expect(() => parse1Pux(bytes, 1024)).toThrow(/unpacks to more than/);
        // A damaged archive is a different thing and says so
        expect(() => parse1Pux(bytes)).not.toThrow();
    });

    // The bound counts what the filter would have taken, not what the archive
    // holds: an export padded with things Vigil never unpacks (1Password
    // writes export.attributes beside the data) must not be refused for them
    it('ignores the size of files it was never going to unpack', () => {
        const bytes = zipSync({
            'export.data': strToU8(JSON.stringify(archive)),
            'export.attributes': strToU8('y'.repeat(8192)),
        });
        expect(parse1Pux(bytes, 4096).length).toBeGreaterThan(0);
    });
});

// A `time` is whatever the file says. Finite is not the same as
// representable, and an Invalid Date on an entry makes every later save of
// the database throw, so a poisoned import would take the open vault with it
describe('1Password unrepresentable timestamps', () => {
    const revision = (time: unknown) => ({
        uuid: 'x', title: 'Site', location: 'https://x.test',
        secureContents: {
            fields: [{ designation: 'username', value: 'u' }, { designation: 'password', value: 'now' }],
            passwordHistory: [{ value: 'old', time }],
        },
    });

    it('drops a 1pif revision time past the range a Date can hold', async () => {
        const file = new File([JSON.stringify(revision(1e15))], 'data.1pif');
        const result = await ImportService.parseFile(file);
        expect(result.entries[0].passwordHistory).toEqual([{ password: 'old', changed: undefined }]);
    });

    it('leaves the database saveable', async () => {
        const file = new File([JSON.stringify(revision(1e15))], 'data.1pif');
        const result = await ImportService.parseFile(file);
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        db.setVersion(3);
        await ImportService.writeEntries(result, db);
        const bytes = await db.save();
        expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('keeps a time it can represent', async () => {
        const file = new File([JSON.stringify(revision(1700000000))], 'data.1pif');
        const result = await ImportService.parseFile(file);
        expect(result.entries[0].passwordHistory?.[0].changed?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    });
});

describe('1Password .1pif', () => {
    const lines = [
        JSON.stringify({
            uuid: 'A', title: 'Mail', location: 'https://mail.example', typeName: 'webforms.WebForm',
            secureContents: {
                fields: [
                    { designation: 'username', value: 'me@x.com', name: 'u', type: 'T' },
                    { designation: 'password', value: 'pw', name: 'p', type: 'P' },
                ],
                notesPlain: 'note text',
                sections: [{
                    title: 'Extra', fields: [
                        { k: 'concealed', n: 'TOTP_1', t: 'one-time password', v: 'otpauth://totp/Mail?secret=GEZDGNBVGY3TQOJQ' },
                        { k: 'concealed', n: 'pin', t: 'PIN', v: '9999' },
                    ],
                }],
                passwordHistory: [{ value: 'old', time: 1600000000 }],
            },
        }),
        PIF_SEPARATOR,
        JSON.stringify({ uuid: 'B', title: 'Trashed', trashed: true, secureContents: { password: 'x' } }),
        PIF_SEPARATOR,
        JSON.stringify({ uuid: 'C', title: 'A note', typeName: 'securenotes.SecureNote', secureContents: { notesPlain: 'just text' } }),
        PIF_SEPARATOR,
        '',
    ].join('\n');

    it('reads items and skips the separator records', async () => {
        const result = await ImportService.parseFile(new File([lines], 'data.1pif'));
        expect(result.source).toBe('1Password');
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toMatchObject({
            title: 'Mail', username: 'me@x.com', password: 'pw',
            url: 'https://mail.example', notes: 'note text',
            totp: 'otpauth://totp/Mail?secret=GEZDGNBVGY3TQOJQ',
        });
        expect(result.entries[0].customFields).toEqual([
            { key: 'Extra / PIN', value: '9999', protected: true },
        ]);
        expect(result.entries[0].passwordHistory).toEqual([
            { password: 'old', changed: new Date(1600000000 * 1000) },
        ]);
    });

    it('leaves a trashed item behind', async () => {
        const result = await ImportService.parseFile(new File([lines], 'data.1pif'));
        expect(result.entries.map(e => e.title)).not.toContain('Trashed');
    });

    // The separator is what tells it apart from any other file of JSON lines,
    // so a file named anything still reads correctly
    it('is recognised by its separator whatever it is called', async () => {
        expect((await ImportService.parseFile(new File([lines], 'export.txt'))).source).toBe('1Password');
    });

    it('does not steal a Bitwarden JSON export', async () => {
        const bitwarden = JSON.stringify({ encrypted: false, folders: [], items: [
            { type: 1, name: 'X', login: { username: 'a', password: 'b' } }] }, null, 2);
        expect((await ImportService.parseFile(new File([bitwarden], 'export.json'))).source).toBe('Bitwarden');
    });
});

// Document items are the one thing a 1pux carries that is not in export.data:
// the file sits under files/<documentId>___<fileName>
describe('1Password document attachments', () => {
    const withDocument = (documentId: string, fileName: string, bytes: Uint8Array, filePath?: string) => {
        const data = {
            accounts: [{
                attrs: { name: 'Me' },
                vaults: [{
                    attrs: { name: 'Private' },
                    items: [{
                        uuid: 'd', state: 'active', categoryUuid: '006',
                        overview: { title: 'Passport scan' },
                        details: {
                            notesPlain: 'renewed in 2029',
                            documentAttributes: { fileName, documentId, decryptedSize: bytes.length },
                        },
                    }],
                }],
            }],
        };
        return new File([zipSync({
            'export.data': strToU8(JSON.stringify(data)),
            'export.attributes': strToU8('{"version":3}'),
            [filePath ?? `files/${documentId}___${fileName}`]: bytes,
        })], 'export.1pux');
    };

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    it('attaches the file to its entry', async () => {
        const result = await ImportService.parseFile(withDocument('poegva18p5aejemc6rk8bpldqq', 'Passport Photo.png', png));
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({ title: 'Passport scan', notes: 'renewed in 2029' });
        expect(result.entries[0].attachments).toHaveLength(1);
        expect(result.entries[0].attachments![0].name).toBe('Passport Photo.png');
        expect([...result.entries[0].attachments![0].data]).toEqual([...png]);
    });

    it('writes the attachment into the database intact', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        const result = await ImportService.parseFile(withDocument('abc123', 'Scan.png', png));
        await ImportService.writeEntries(result, db);
        const entry = db.getDefaultGroup().groups
            .find(g => g.name === 'Imported (1Password)')!
            .groups.find(g => g.name === 'Private')!.entries[0];
        const binary = entry.binaries.get('Scan.png');
        const stored = binary instanceof kdbxweb.ProtectedValue
            ? binary.getBinary()
            : new Uint8Array((binary as { value: ArrayBuffer })?.value ?? (binary as ArrayBuffer));
        expect([...stored]).toEqual([...png]);
    });

    // The id is what the item names; the file name in the path has been
    // through whatever the exporting platform does to file names
    it('matches on the document id, not the whole path', async () => {
        const result = await ImportService.parseFile(
            withDocument('abc123', 'Ünïcodé Scan.png', png, 'files/abc123___U776Ynicode Scan.png'));
        expect(result.entries[0].attachments![0].name).toBe('Ünïcodé Scan.png');
    });

    // A document whose file is missing from the archive still deserves its
    // entry: the title and notes are real data
    it('keeps the entry when the file is absent from the archive', async () => {
        const data = {
            accounts: [{
                attrs: { name: 'Me' },
                vaults: [{
                    attrs: { name: 'Private' },
                    items: [{
                        uuid: 'd', state: 'active', categoryUuid: '006',
                        overview: { title: 'Missing scan' },
                        details: { notesPlain: 'the file did not come along', documentAttributes: { fileName: 'x.png', documentId: 'gone' } },
                    }],
                }],
            }],
        };
        const result = await ImportService.parseFile(
            new File([zipSync({ 'export.data': strToU8(JSON.stringify(data)) })], 'export.1pux'));
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].attachments).toBeUndefined();
        expect(result.entries[0].notes).toBe('the file did not come along');
    });
});

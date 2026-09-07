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

    // A custom field's name is whoever wrote the export's to choose, and one
    // named like a standard field used to be written straight over it: the
    // entry's real password was replaced by the custom value, and stored as
    // a plain string where a ProtectedValue had been
    it('keeps a custom field named like a standard one from taking its place', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

        const result = await ImportService.parseFile(fileOf('export.json', JSON.stringify({
            items: [{
                type: 1, name: 'Bank',
                login: { username: 'me', password: 'realsecret', uris: [{ uri: 'https://bank.example' }] },
                fields: [
                    { name: 'Password', value: 'not the password', type: 0 },
                    { name: 'Title', value: 'not the title', type: 0 },
                    { name: 'otp', value: 'not a code', type: 0 },
                    { name: 'KPEX_PASSKEY_PRIVATE_KEY_PEM', value: 'not a passkey', type: 0 },
                    // Two of the same name: the second used to replace the first
                    { name: 'Note', value: 'first', type: 0 },
                    { name: 'Note', value: 'second', type: 0 },
                ],
            }],
        })));
        await ImportService.importToDatabase(result, kdbxDb);

        const reloaded = await loadSaved(env);
        const entry = reloaded.getDefaultGroup().groups.find(g => g.name === 'Imported (Bitwarden)')!.entries[0];

        const password = entry.fields.get('Password');
        expect(password).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((password as kdbxweb.ProtectedValue).getText()).toBe('realsecret');
        expect(entry.fields.get('Title')).toBe('Bank');
        expect(entry.fields.get('otp')).toBeUndefined();
        expect(entry.fields.get('KPEX_PASSKEY_PRIVATE_KEY_PEM')).toBeUndefined();

        // Renamed out of the way, and protected because they were named
        // after fields of ours
        for (const [key, text] of [['Password_2', 'not the password'], ['Title_2', 'not the title'],
            ['otp_2', 'not a code'], ['KPEX_PASSKEY_PRIVATE_KEY_PEM_2', 'not a passkey']] as const) {
            const value = entry.fields.get(key);
            expect(value).toBeInstanceOf(kdbxweb.ProtectedValue);
            expect((value as kdbxweb.ProtectedValue).getText()).toBe(text);
        }

        // A name that collides with nothing of ours keeps its own protection
        expect(entry.fields.get('Note')).toBe('first');
        expect(entry.fields.get('Note_2')).toBe('second');
    });

    // Bitwarden stores a Steam secret as steam://<key> in its TOTP field, so
    // that is the shape a Bitwarden export carries. It has to survive the
    // rewrite into the otpauth URI Vigil stores, or the imported entry is an
    // ordinary six digit one that Steam rejects
    it('keeps a Bitwarden steam:// secret a Steam one', async () => {
        const STEAM_B32 = 'Z3ZBVSU5ZE7PW3276QDB5KZKFAMT7Y4L';
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

        const result = await ImportService.parseFile(fileOf('export.json', JSON.stringify({
            items: [
                { type: 1, name: 'Steam', login: { username: 'bob', password: 'pw', totp: `steam://${STEAM_B32}` } },
                // the maFile URI shape, which declares nothing itself
                { type: 1, name: 'Steam2', login: { username: 'bob', password: 'pw', totp: `otpauth://totp/Steam:bob?secret=${STEAM_B32}&issuer=Steam` } },
                { type: 1, name: 'Normal', login: { username: 'bob', password: 'pw', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } },
            ],
        })));
        await ImportService.importToDatabase(result, kdbxDb);

        const reloaded = await loadSaved(env);
        const imported = reloaded.getDefaultGroup().groups.find(g => g.name === 'Imported (Bitwarden)')!;
        const { TotpService } = await import('../src/services/TotpService');
        const configOf = (title: string) => {
            const entry = imported.entries.find(e => e.fields.get('Title') === title)!;
            return TotpService.getConfig([...entry.fields]
                .filter(([key]) => key === 'otp')
                .map(([key, value]) => ({ key, value, protected: value instanceof kdbxweb.ProtectedValue })));
        };

        expect(configOf('Steam')).toMatchObject({ encoder: 'steam', digits: 5 });
        expect(configOf('Steam2')).toMatchObject({ encoder: 'steam', digits: 5 });
        expect(configOf('Normal')?.encoder).toBeUndefined();
    });

    // The file is whatever was on disk. A value of the wrong type used to
    // reach a kdbx field map untouched, so a number was stored as a number
    // and an object reached ProtectedValue.fromString
    it('takes only usable values out of a hand-crafted JSON export', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

        const result = await ImportService.parseFile(fileOf('export.json', JSON.stringify({
            folders: { nope: 'not a list' },
            items: [
                null,
                42,
                {
                    type: 1,
                    name: { toString: 'not callable' },
                    notes: true,
                    folderId: { id: 1 },
                    login: { username: 7, password: ['a'], uris: 'https://example.com', totp: {} },
                    fields: { nope: 1 },
                },
            ],
        })));

        // The two unusable items are skipped, the third survives with only
        // the values that were usable
        expect(result.skipped).toBe(2);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({ title: 'Untitled', username: '7', password: '' });
        expect(result.entries[0].url).toBeUndefined();
        expect(result.entries[0].notes).toBeUndefined();
        expect(result.entries[0].totp).toBeUndefined();
        expect(result.entries[0].group).toBeUndefined();

        // and it writes and reloads without throwing
        await ImportService.importToDatabase(result, kdbxDb);
        const reloaded = await loadSaved(env);
        const entry = reloaded.getDefaultGroup().groups.find(g => g.name === 'Imported (Bitwarden)')!.entries[0];
        expect(entry.fields.get('Title')).toBe('Untitled');
        expect(entry.fields.get('UserName')).toBe('7');
    });
});

describe('hotp import', () => {
    it('keeps a Bitwarden hotp URI and reads its counter back', async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());

        const result = await ImportService.parseFile(fileOf('export.json', JSON.stringify({
            items: [{
                type: 1, name: 'Counter',
                login: { username: 'u', password: 'p', totp: 'otpauth://hotp/Counter?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=9' },
            }],
        })));
        expect(await ImportService.importToDatabase(result, kdbxDb)).toBe(1);

        const reloaded = await loadSaved(env);
        const database = Svc.convertKdbxToDatabase(reloaded);
        const imported = database.root.groups.find(g => g.name === 'Imported (Bitwarden)')!;
        const { TotpService } = await import('../src/services/TotpService');
        expect(TotpService.getConfig(imported.entries[0].customFields)).toMatchObject({ type: 'hotp', counter: 9 });
    });
});

// Everything a Bitwarden export carries that has a home in a kdbx entry.
// Each of these used to be dropped, most of them without even reaching the
// skipped count, so an import looked clean while credentials went missing.
// The schema is bitwarden/clients libs/common/src/models/export
describe('bitwarden export coverage', () => {
    // writeEntries only needs somewhere to create groups, entries and
    // binaries, so these skip the save and reload the other tests do
    const newDb = async () => kdbxweb.Kdbx.create(cred(), 'Vault');
    const importedRoot = (db: kdbxweb.Kdbx) =>
        db.getDefaultGroup().groups.find(g => g.name === 'Imported (Bitwarden)')!;

    // An organization export has no `folders` key at all: it carries
    // `collections`, and items name them in `collectionIds`. Every entry
    // used to land loose in the import group
    it('groups an organization export by its collections', async () => {
        const db = await newDb();
        const result = await ImportService.parseFile(fileOf('org.json', JSON.stringify({
            encrypted: false,
            collections: [{ id: 'c1', name: 'Engineering', organizationId: 'o1' }],
            items: [{
                type: 1, name: 'Jenkins', organizationId: 'o1', collectionIds: ['c1'],
                login: { uris: [{ uri: 'https://ci.example' }], username: 'ci', password: 'pw' },
            }],
        })));
        expect(result.entries[0].group).toEqual(['Engineering']);
        await ImportService.writeEntries(result, db);
        expect(importedRoot(db).groups[0].name).toBe('Engineering');
        expect(importedRoot(db).groups[0].entries[0].fields.get('Title')).toBe('Jenkins');
    });

    // A kdbx entry has one URL field, so the rest go where KeePassXC and
    // Keepass2Android look for them
    it('keeps every URI, not just the first', async () => {
        const db = await newDb();
        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [{
                type: 1, name: 'GitHub',
                login: {
                    username: 'octo', password: 'pw',
                    uris: [{ uri: 'https://github.com' }, { uri: 'https://gist.github.com' }, { uri: 'https://api.github.com' }],
                },
            }],
        })));
        await ImportService.writeEntries(result, db);
        const entry = importedRoot(db).entries[0];
        expect(entry.fields.get('URL')).toBe('https://github.com');
        expect(entry.fields.get('KP2A_URL_1')).toBe('https://gist.github.com');
        expect(entry.fields.get('KP2A_URL_2')).toBe('https://api.github.com');
    });

    // kdbx history is a snapshot of the whole entry, so the replay has to run
    // after every other field is in place, oldest revision first
    it('replays password history into the entry history', async () => {
        const db = await newDb();
        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [{
                type: 1, name: 'Bank', login: { username: 'me', password: 'current' },
                // newest first in the file, as Bitwarden writes it
                passwordHistory: [
                    { lastUsedDate: '2024-06-01T00:00:00Z', password: 'middle' },
                    { lastUsedDate: '2023-01-01T00:00:00Z', password: 'oldest' },
                ],
            }],
        })));
        await ImportService.writeEntries(result, db);
        const entry = importedRoot(db).entries[0];
        expect(entry.history.map(h => (h.fields.get('Password') as kdbxweb.ProtectedValue).getText()))
            .toEqual(['oldest', 'middle']);
        expect((entry.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('current');
        // the snapshots carry the entry's other values, which is all kdbx can do
        expect(entry.history[0].fields.get('UserName')).toBe('me');
    });

    // CipherType 5. Bitwarden stores the key unencrypted, so the entry
    // password stays empty and that is the passphrase
    it('turns an SSH key item into a KeeAgent entry', async () => {
        const db = await newDb();
        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [{
                type: 5, name: 'work key',
                sshKey: {
                    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
                    publicKey: 'ssh-ed25519 AAAAC3 me@host',
                    keyFingerprint: 'SHA256:x',
                },
            }],
        })));
        expect(result.skipped).toBe(0);
        await ImportService.writeEntries(result, db);
        const entry = importedRoot(db).entries[0];
        expect([...entry.binaries.keys()].sort())
            .toEqual(['KeeAgent.settings', 'work key.key', 'work key.key.pub']);
    });

    it('still counts the types a kdbx entry cannot hold', async () => {
        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [
                { type: 3, name: 'Card' },
                { type: 4, name: 'Identity' },
                { type: 6, name: 'Bank account' },
                { type: 7, name: 'Licence' },
                { type: 8, name: 'Passport' },
                { type: 1, name: 'Login', login: { username: 'a', password: 'b' } },
            ],
        })));
        expect(result.skipped).toBe(5);
        expect(result.entries).toHaveLength(1);
    });
});

// The one conversion that can silently produce a credential that looks right
// and never signs. Bitwarden writes the PKCS#8 key as base64url and the
// credential id as a GUID standing for its sixteen raw bytes; KeePassXC's
// attributes want a PEM and base64url. Rather than compare strings, this
// imports a key it generated, asserts with it, and verifies the signature
// against the public half the key was made with
describe('bitwarden passkey import', () => {
    it('imports a credential that still signs for its relying party', async () => {
        const { PasskeyService, b64urlEncode } = await import('../src/services/PasskeyService');
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [{
                type: 1, name: 'GitHub',
                login: {
                    username: 'octo', password: 'pw',
                    fido2Credentials: [{
                        credentialId: '550e8400-e29b-41d4-a716-446655440000',
                        keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
                        keyValue: b64urlEncode(pkcs8),
                        rpId: 'github.com',
                        userHandle: b64urlEncode(new Uint8Array([1, 2, 3, 4])),
                        userName: 'octo', counter: '0', discoverable: 'true',
                    }],
                },
            }],
        })));
        await ImportService.writeEntries(result, db);

        // The GUID is its bytes in written order, so the id round-trips
        const found = PasskeyService.passkeyEntries(db, 'github.com');
        expect(found).toHaveLength(1);
        expect(found[0].credentialId).toBe(b64urlEncode(
            new Uint8Array([0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4,
                0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00])));
        expect(found[0].entry.tags).toContain('Passkey');

        const assertion = await PasskeyService.assert(
            found[0], { challenge: 'Y2hhbGxlbmdlY2hhbGxlbmdl' }, 'https://github.com', 'github.com');
        expect(assertion.errorCode).toBeUndefined();

        const b64d = (s: string) =>
            Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const authData = b64d(assertion.response.authenticatorData);
        const clientHash = new Uint8Array(
            await crypto.subtle.digest('SHA-256', b64d(assertion.response.clientDataJSON)));
        const signed = new Uint8Array([...authData, ...clientHash]);

        // WebAuthn signatures are DER; WebCrypto verifies raw r||s
        const der = b64d(assertion.response.signature);
        const rLength = der[3];
        const sLength = der[3 + rLength + 2];
        const pad32 = (b: Uint8Array) =>
            b.length > 32 ? b.slice(b.length - 32) : new Uint8Array([...new Uint8Array(32 - b.length), ...b]);
        const raw = new Uint8Array([
            ...pad32(der.slice(4, 4 + rLength)),
            ...pad32(der.slice(4 + rLength + 2, 4 + rLength + 2 + sLength)),
        ]);

        expect(await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, raw, signed)).toBe(true);
    });

    // The model is an array; Bitwarden's own UI makes one per item. Any
    // beyond the first get an entry rather than being dropped
    it('gives a second credential on one item its own entry', async () => {
        const { b64urlEncode } = await import('../src/services/PasskeyService');
        const key = async () => b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8',
            ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair).privateKey)));
        const credential = async (rpId: string) => ({
            credentialId: `b64.${b64urlEncode(new Uint8Array([1, 2, 3]))}`,
            keyValue: await key(), rpId, userName: 'octo', userHandle: 'AQID', counter: '0',
        });

        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [{
                type: 1, name: 'Multi',
                login: {
                    username: 'octo', password: 'pw',
                    fido2Credentials: [await credential('one.example'), await credential('two.example')],
                },
            }],
        })));
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].passkey?.relyingParty).toBe('one.example');
        expect(result.entries[1].title).toBe('Multi (two.example passkey)');
        // the spun-off entry carries no copy of the login's password
        expect(result.entries[1].password).toBe('');
    });

    it('drops a credential with no usable key rather than storing a dead one', async () => {
        const result = await ImportService.parseFile(fileOf('x.json', JSON.stringify({
            items: [{
                type: 1, name: 'Broken',
                login: {
                    username: 'octo', password: 'pw',
                    fido2Credentials: [{ credentialId: 'not-a-guid', keyValue: '!!!', rpId: 'x.example' }],
                },
            }],
        })));
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].passkey).toBeUndefined();
    });
});

// The CSV formats, checked against what each tool actually writes:
// Bitwarden's own export type and importer, LastPass's grouping sentinel,
// 1Password 8's header row, and KeePassXC's CsvExporter columns
describe('csv export coverage', () => {
    const parse = (name: string, csv: string) => ImportService.parseFile(fileOf(name, csv));

    // login_uri holds every URL in one comma separated cell, and fields
    // flattens the custom fields into one cell of "name: value" lines
    it('splits a Bitwarden CSV multi-URL cell and reads its custom fields', async () => {
        const result = await parse('bw.csv',
            'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp,archivedDate\n'
            + 'Work,1,login,GitHub,a note,"PIN: 1234\nRecovery: shh",0,'
            + '"https://github.com,https://gist.github.com",octo,pw,JBSWY3DPEHPK3PXP,\n');
        expect(result.entries[0]).toMatchObject({
            title: 'GitHub',
            url: 'https://github.com',
            extraUrls: ['https://gist.github.com'],
            group: ['Work'],
        });
        expect(result.entries[0].customFields).toEqual([
            { key: 'PIN', value: '1234', protected: false },
            { key: 'Recovery', value: 'shh', protected: false },
        ]);
    });

    // A field name may contain ": ", so the split is on the last one
    it('splits a Bitwarden CSV field on the last delimiter', async () => {
        const result = await parse('bw.csv',
            'folder,type,name,fields,login_username,login_password\n'
            + ',login,X,"Note: to self: value",u,p\n');
        expect(result.entries[0].customFields).toEqual([
            { key: 'Note: to self', value: 'value', protected: false },
        ]);
    });

    // An organization CSV has no folder column: it writes `collections`,
    // comma separated because an item can sit in several
    it('groups a Bitwarden organization CSV by its collections', async () => {
        const result = await parse('bw.csv',
            'collections,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
            + '"Engineering,Ops",0,login,Jenkins,,,0,https://ci.example,ci,pw,\n');
        expect(result.entries[0].group).toEqual(['Engineering']);
    });

    // LastPass writes the literal "(none)" for an item in no folder
    it('does not make a LastPass group called (none)', async () => {
        const result = await parse('lp.csv',
            'url,username,password,totp,extra,name,grouping,fav\n'
            + 'https://a.example,me,pw,,,Alpha,(none),0\n'
            + 'https://b.example,me2,pw2,,,Beta,Personal\\Banking,0\n');
        expect(result.entries[0].group).toBeUndefined();
        expect(result.entries[1].group).toEqual(['Personal', 'Banking']);
    });

    // Header row per pass-import's OnePassword8CSV mapping
    it('reads a 1Password 8 export', async () => {
        const result = await parse('1p.csv',
            'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n'
            + 'Mail,https://mail.example,me@x.com,pw,otpauth://totp/Mail?secret=GEZDGNBVGY3TQOJQ,,,"work,email",note here\n');
        expect(result.source).toBe('1Password');
        expect(result.entries[0]).toMatchObject({
            title: 'Mail', username: 'me@x.com', url: 'https://mail.example',
            totp: 'otpauth://totp/Mail?secret=GEZDGNBVGY3TQOJQ', tags: ['work', 'email'],
        });
    });

    // KeePassXC's CsvExporter writes the root group's own name at the front
    // of every path, and its TOTP column is a settings string rather than
    // always a URI (Totp::writeSettings). The KeeOtp spelling used to be
    // dropped on the way in
    it('reads a KeePassXC export, including a KeeOtp TOTP column', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        const result = await parse('kp.csv',
            'Group,Title,Username,Password,URL,Notes,TOTP,Icon,Last Modified,Created\n'
            + 'Root/Work,GitHub,octo,pw,https://github.com,n,key=GEZDGNBVGY3TQOJQ&size=6&step=30,0,,\n');
        expect(result.source).toBe('KeePassXC');
        expect(result.entries[0].group).toEqual(['Work']);

        await ImportService.writeEntries(result, db);
        const entry = db.getDefaultGroup().groups
            .find(g => g.name === 'Imported (KeePassXC)')!.groups[0].entries[0];
        const otp = entry.fields.get('otp') as kdbxweb.ProtectedValue;
        expect(otp.getText()).toContain('otpauth://totp/');
        expect(otp.getText()).toContain('secret=GEZDGNBVGY3TQOJQ');
    });

    it('routes browser exports to the generic parser', async () => {
        const chrome = await parse('c.csv', 'name,url,username,password,note\nexample.com,https://example.com,me,pw,a note\n');
        expect(chrome.entries[0]).toMatchObject({ title: 'example.com', url: 'https://example.com', notes: 'a note' });

        // Firefox has no name column, so the title comes from the host
        const firefox = await parse('ff.csv',
            '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated"\n'
            + '"https://example.com","me","pw","","https://example.com","{x}","1"\n');
        expect(firefox.entries[0]).toMatchObject({ title: 'example.com', username: 'me', password: 'pw' });
    });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { gzipSync, strToU8 } from 'fflate';
import { installMockWindow, cred, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { ImportService } = await import('../src/services/ImportService');

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const file = (name: string, content: string) => new File([content], name);

// The KeePass2 XML document, as KdbxXmlWriter emits it: entries are String
// key/value pairs, attachments are inlined under Meta > Binaries and
// referenced by id, and History holds whole past entries
describe('KeePassXC XML export', () => {
    const attachment = strToU8('the attached bytes');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<KeePassFile>
  <Meta>
    <DatabaseName>Vault</DatabaseName>
    <RecycleBinUUID>0LDPvSl0S0uEqPLHDgTvBw==</RecycleBinUUID>
    <Binaries>
      <Binary ID="0" Compressed="True">${b64(gzipSync(attachment))}</Binary>
      <Binary ID="1" Compressed="False">${b64(strToU8('plain bytes'))}</Binary>
    </Binaries>
  </Meta>
  <Root>
    <Group>
      <UUID>cm9vdC1ncm91cC11dWlkLS0tLQ==</UUID>
      <Name>Passwords</Name>
      <Entry>
        <UUID>ZW50cnktYXQtdGhlLXJvb3QtLS0=</UUID>
        <String><Key>Title</Key><Value>Root level</Value></String>
        <String><Key>Password</Key><Value Protected="True">rootpw</Value></String>
      </Entry>
      <Group>
        <UUID>d29yay1ncm91cC11dWlkLS0tLS0=</UUID>
        <Name>Work</Name>
        <Entry>
          <UUID>Z2l0aHViLWVudHJ5LXV1aWQtLS0=</UUID>
          <Tags>dev;ci</Tags>
          <String><Key>Title</Key><Value>GitHub</Value></String>
          <String><Key>UserName</Key><Value>octo</Value></String>
          <String><Key>Password</Key><Value Protected="True">current</Value></String>
          <String><Key>URL</Key><Value>https://github.com</Value></String>
          <String><Key>Notes</Key><Value>line one
line two</Value></String>
          <String><Key>otp</Key><Value Protected="True">otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQ</Value></String>
          <String><Key>Recovery</Key><Value Protected="True">shh</Value></String>
          <String><Key>Team</Key><Value>platform</Value></String>
          <Binary><Key>notes.txt</Key><Value Ref="0"/></Binary>
          <Binary><Key>other.bin</Key><Value Ref="1"/></Binary>
          <History>
            <Entry>
              <String><Key>Password</Key><Value Protected="True">older</Value></String>
              <Times><LastModificationTime>2023-01-01T00:00:00Z</LastModificationTime></Times>
            </Entry>
            <Entry>
              <String><Key>Password</Key><Value Protected="True">newer</Value></String>
              <Times><LastModificationTime>2024-06-01T00:00:00Z</LastModificationTime></Times>
            </Entry>
          </History>
        </Entry>
      </Group>
      <Group>
        <UUID>0LDPvSl0S0uEqPLHDgTvBw==</UUID>
        <Name>Recycle Bin</Name>
        <Entry>
          <String><Key>Title</Key><Value>Deleted thing</Value></String>
          <String><Key>Password</Key><Value>gone</Value></String>
        </Entry>
      </Group>
    </Group>
  </Root>
</KeePassFile>`;

    it('reads entries, groups, protection and tags', async () => {
        const result = await ImportService.parseFile(file('export.xml', xml));
        expect(result.source).toBe('KeePassXC');
        const gh = result.entries.find(e => e.title === 'GitHub')!;
        expect(gh).toMatchObject({
            username: 'octo', password: 'current', url: 'https://github.com',
            notes: 'line one\nline two',
            totp: 'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQ',
            group: ['Work'],
            tags: ['dev', 'ci'],
        });
        // Protection recorded per field is carried across
        expect(gh.customFields).toEqual([
            { key: 'Recovery', value: 'shh', protected: true },
            { key: 'Team', value: 'platform', protected: false },
        ]);
    });

    // The root group's name is the database's, not a folder anyone made
    it('does not turn the root group into a folder', async () => {
        const result = await ImportService.parseFile(file('export.xml', xml));
        expect(result.entries.find(e => e.title === 'Root level')?.group).toBeUndefined();
    });

    it('leaves the recycle bin behind', async () => {
        const result = await ImportService.parseFile(file('export.xml', xml));
        expect(result.entries.map(e => e.title)).not.toContain('Deleted thing');
    });

    // Meta > Binaries holds each attachment once, gzipped or not
    it('inflates the attachments and hangs them on their entry', async () => {
        const result = await ImportService.parseFile(file('export.xml', xml));
        const gh = result.entries.find(e => e.title === 'GitHub')!;
        expect(gh.attachments?.map(a => a.name)).toEqual(['notes.txt', 'other.bin']);
        expect(new TextDecoder().decode(gh.attachments![0].data)).toBe('the attached bytes');
        expect(new TextDecoder().decode(gh.attachments![1].data)).toBe('plain bytes');
    });

    // History holds whole past entries; their passwords rebuild the revisions
    it('replays the history, oldest first, without importing it as entries', async () => {
        const result = await ImportService.parseFile(file('export.xml', xml));
        expect(result.entries).toHaveLength(2);
        const gh = result.entries.find(e => e.title === 'GitHub')!;
        expect(gh.passwordHistory?.map(h => h.password)).toEqual(['older', 'newer']);
    });

    it('writes through to a database', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        const result = await ImportService.parseFile(file('export.xml', xml));
        await ImportService.writeEntries(result, db);
        const root = db.getDefaultGroup().groups.find(g => g.name === 'Imported (KeePassXC)')!;
        const gh = root.groups.find(g => g.name === 'Work')!.entries[0];
        expect([...gh.binaries.keys()].sort()).toEqual(['notes.txt', 'other.bin']);
        expect(gh.history.map(h => (h.fields.get('Password') as kdbxweb.ProtectedValue).getText()))
            .toEqual(['older', 'newer']);
        expect((gh.fields.get('otp') as kdbxweb.ProtectedValue).getText()).toContain('otpauth://');
    });

    it('refuses XML that is not a KeePass export', async () => {
        // Not a KeePass document and not the report either, so it falls
        // through to the CSV reader and is refused there
        await expect(ImportService.parseFile(file('x.xml', '<?xml version="1.0"?><rss><channel/></rss>')))
            .rejects.toThrow(/no entries/);
        await expect(ImportService.parseFile(file('x.xml', '<KeePassFile><Meta/></KeePassFile>')))
            .rejects.toThrow(/not a KeePass export/);
    });
});

// The report is made for printing: it carries no attachments, history, tags
// or field protection, and truncates a URL past a hundred characters. It is
// recognised only so it can be refused for what it is, rather than falling
// through to the CSV reader and being reported as empty
describe('KeePassXC HTML report', () => {
    const html = `<html><head><meta charset="UTF-8"><title>Vault</title></head><body>
<h1>Vault</h1>
<hr><h2>Passwords &rarr; Work</h2>
<table width="95%"><tr><td style="padding-bottom: 0.5em;"><table width="100%"><caption>GitHub</caption>
<tr><th>User name</th><td class="username">octo</td></tr>
<tr><th>Password</th><td class="password">pw</td></tr>
<tr><th>Notes</th><td class="notes">line one<br>line two</td></tr>
</table></td></tr></table>
</body></html>`;

    it('is refused by name rather than called empty', async () => {
        await expect(ImportService.parseFile(file('export.html', html)))
            .rejects.toThrow(/HTML report.*Export as XML or CSV/);
    });

    it('does not claim an unrelated HTML page', async () => {
        await expect(ImportService.parseFile(file('page.html', '<html><body><table><tr><td>hi</td></tr></table></body></html>')))
            .rejects.toThrow(/no entries/);
    });
});

// The fixtures above are handwritten from KeePassXC's writers. This one is
// produced by kdbxweb, an independent implementation of the same document,
// so the parser is read against something it did not have a hand in shaping
describe('KeePassXC XML against a real writer', () => {
    it('round-trips a document kdbxweb produced', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'MyVault');
        db.setVersion(4);
        const work = db.createGroup(db.getDefaultGroup(), 'Work');
        const entry = db.createEntry(work);
        entry.fields.set('Title', 'GitHub');
        entry.fields.set('UserName', 'octo');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('was current'));
        entry.fields.set('URL', 'https://github.com');
        entry.fields.set('Notes', 'line one\nline two');
        entry.fields.set('otp', kdbxweb.ProtectedValue.fromString('otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQ'));
        entry.fields.set('Recovery', kdbxweb.ProtectedValue.fromString('shh'));
        entry.fields.set('Team', 'platform');
        entry.tags = ['dev', 'ci'];
        entry.pushHistory();
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('newest'));

        const result = await ImportService.parseFile(file('export.xml', await db.saveXml()));
        expect(result.source).toBe('KeePassXC');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
            title: 'GitHub', username: 'octo', password: 'newest',
            url: 'https://github.com', notes: 'line one\nline two',
            totp: 'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQ',
            group: ['Work'], tags: ['dev', 'ci'],
        });
        // kdbxweb marks Password and anything the database protects
        expect(result.entries[0].customFields).toEqual([
            { key: 'Recovery', value: 'shh', protected: true },
            { key: 'Team', value: 'platform', protected: false },
        ]);
        expect(result.entries[0].passwordHistory?.map(h => h.password)).toEqual(['was current']);
    });
});

// KDBX4 writes a time as seconds since year one, base64 as a little-endian
// int64. A value near that type's ceiling is a finite count of milliseconds
// that is still past the range a Date can hold, and an Invalid Date on an
// entry makes every later save of the database throw
describe('KeePassXC XML unrepresentable timestamps', () => {
    const withTime = (bytes: number[]) => `<?xml version="1.0"?><KeePassFile><Meta/><Root><Group><Name>G</Name>
<Entry><String><Key>Title</Key><Value>Site</Value></String><String><Key>Password</Key><Value>now</Value></String>
<History><Entry><String><Key>Password</Key><Value>old</Value></String>
<Times><LastModificationTime>${b64(new Uint8Array(bytes))}</LastModificationTime></Times></Entry></History>
</Entry></Group></Root></KeePassFile>`;

    it('drops an int64 time past the range a Date can hold', async () => {
        const result = await ImportService.parseFile(file('export.xml', withTime([0, 0, 0, 0, 0, 0, 0, 0x40])));
        expect(result.entries[0].passwordHistory).toEqual([{ password: 'old', changed: undefined }]);
    });

    // What the save path chokes on. The 1pif suite runs the save itself;
    // here kdbxweb's own Meta.write trips over jsdom's second ArrayBuffer
    // realm before it ever reaches an entry
    it('never stamps an entry with a date it cannot write', async () => {
        const result = await ImportService.parseFile(file('export.xml', withTime([0, 0, 0, 0, 0, 0, 0, 0x40])));
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        await ImportService.writeEntries(result, db);
        const entry = [...db.getDefaultGroup().allEntries()][0];
        for (const times of [entry.times, ...entry.history.map(h => h.times)]) {
            expect(Number.isNaN(times.lastModTime!.getTime())).toBe(false);
        }
    });

    it('keeps a time it can represent', async () => {
        // 2023-11-14T22:13:20Z, seconds since year one, little-endian
        const seconds = 1700000000 + 62135596800;
        const bytes = Array.from({ length: 8 }, (_, i) => Math.floor(seconds / 2 ** (8 * i)) & 0xff);
        const result = await ImportService.parseFile(file('export.xml', withTime(bytes)));
        expect(result.entries[0].passwordHistory?.[0].changed?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    });
});

// SshAgentService reads this record on unlock and loads the key it points at
// into the agent. Carried across as written, an export could name a key it
// brought with it and have it enrolled without anyone asking
describe('KeeAgent record in an imported file', () => {
    const settings = (addAtOpen: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<EntrySettings>
  <AllowUseOfSshKey>true</AllowUseOfSshKey>
  <AddAtDatabaseOpen>${addAtOpen}</AddAtDatabaseOpen>
  <RemoveAtDatabaseClose>true</RemoveAtDatabaseClose>
  <Location><SelectedType>attachment</SelectedType><AttachmentName>id_ed25519</AttachmentName></Location>
</EntrySettings>`;

    const xml = (addAtOpen: boolean) => `<?xml version="1.0"?><KeePassFile><Meta><Binaries>
<Binary ID="0" Compressed="False">${b64(strToU8(settings(addAtOpen)))}</Binary>
<Binary ID="1" Compressed="False">${b64(strToU8('-----BEGIN OPENSSH PRIVATE KEY-----\n'))}</Binary>
</Binaries></Meta><Root><Group><Name>G</Name>
<Entry><String><Key>Title</Key><Value>Server</Value></String><String><Key>Password</Key><Value>p</Value></String>
<Binary><Key>KeeAgent.settings</Key><Value Ref="0"/></Binary>
<Binary><Key>id_ed25519</Key><Value Ref="1"/></Binary>
</Entry></Group></Root></KeePassFile>`;

    const readRecord = async (addAtOpen: boolean) => {
        const result = await ImportService.parseFile(file('export.xml', xml(addAtOpen)));
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        await ImportService.writeEntries(result, db);
        const entry = [...db.getDefaultGroup().allEntries()][0];
        const binary = entry.binaries.get('KeeAgent.settings') as { value: ArrayBuffer };
        return { entry, text: new TextDecoder().decode(new Uint8Array(binary.value)) };
    };

    it('clears AddAtDatabaseOpen but keeps the rest of the record', async () => {
        const { entry, text } = await readRecord(true);
        expect(text).toContain('<AddAtDatabaseOpen>false</AddAtDatabaseOpen>');
        expect(text).toContain('<AllowUseOfSshKey>true</AllowUseOfSshKey>');
        expect(text).toContain('<RemoveAtDatabaseClose>true</RemoveAtDatabaseClose>');
        expect(text).toContain('<AttachmentName>id_ed25519</AttachmentName>');
        expect([...entry.binaries.keys()]).toContain('id_ed25519');
    });

    it('leaves a record that never asked for it alone', async () => {
        const { text } = await readRecord(false);
        expect(text).toContain('<AddAtDatabaseOpen>false</AddAtDatabaseOpen>');
        expect(text).toContain('<AllowUseOfSshKey>true</AllowUseOfSshKey>');
    });
});

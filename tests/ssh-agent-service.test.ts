// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';

const { SshAgentService, DEFAULT_KEEAGENT_SETTINGS, ENABLED_KEEAGENT_SETTINGS, KEEAGENT_SETTINGS_ATTACHMENT } =
    await import('../src/services/SshAgentService');
const { userSettingsService } = await import('../src/services/UserSettingsService');

// As KeePassXC 2.7 writes it (KeeAgentSettings::toXml)
const KEEPASSXC_RECORD = `<?xml version="1.0" encoding="UTF-8"?>
<EntrySettings xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <AllowUseOfSshKey>true</AllowUseOfSshKey>
  <AddAtDatabaseOpen>true</AddAtDatabaseOpen>
  <RemoveAtDatabaseClose>true</RemoveAtDatabaseClose>
  <UseConfirmConstraintWhenAdding>false</UseConfirmConstraintWhenAdding>
  <UseLifetimeConstraintWhenAdding>true</UseLifetimeConstraintWhenAdding>
  <LifetimeConstraintDuration>1800</LifetimeConstraintDuration>
  <Location>
    <SelectedType>attachment</SelectedType>
    <AttachmentName>id_ed25519</AttachmentName>
    <SaveAttachmentToTempFile>false</SaveAttachmentToTempFile>
    <FileName/>
  </Location>
</EntrySettings>
`;

// The KeePass plugin serialises with .NET's XmlSerializer: a BOM, CRLF, and
// True/False capitalised
const KEEAGENT_PLUGIN_RECORD = '\ufeff<?xml version="1.0" encoding="utf-8"?>\r\n'
    + '<EntrySettings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\r\n'
    + '  <AllowUseOfSshKey>True</AllowUseOfSshKey>\r\n  <AddAtDatabaseOpen>True</AddAtDatabaseOpen>\r\n'
    + '  <RemoveAtDatabaseClose>False</RemoveAtDatabaseClose>\r\n  <Location>\r\n    <SelectedType>file</SelectedType>\r\n'
    + '    <FileName>C:\\keys\\id_rsa</FileName>\r\n  </Location>\r\n</EntrySettings>';

const bytes = (text: string): ArrayBuffer => {
    const u8 = new TextEncoder().encode(text);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

const entryWith = (attachments: Array<{ name: string; data: ArrayBuffer | kdbxweb.ProtectedValue }>, password: string | kdbxweb.ProtectedValue = 'pw'): any => ({
    id: 'e1', title: 'Server', username: 'deploy', password, attachments, customFields: [], tags: [], history: [],
    created: new Date(), modified: new Date(), expires: false,
});

describe('KeeAgent settings record', () => {
    it('reads what KeePassXC writes', () => {
        const s = SshAgentService.parseSettings(KEEPASSXC_RECORD)!;
        expect(s).toEqual({
            ...DEFAULT_KEEAGENT_SETTINGS,
            allowUseOfSshKey: true, addAtDatabaseOpen: true, removeAtDatabaseClose: true,
            useLifetimeConstraintWhenAdding: true, lifetimeConstraintDuration: 1800,
            selectedType: 'attachment', attachmentName: 'id_ed25519',
        });
    });

    it('reads what the KeePass plugin writes: BOM, CRLF, capitalised booleans, missing elements', () => {
        const s = SshAgentService.parseSettings(new TextEncoder().encode(KEEAGENT_PLUGIN_RECORD))!;
        expect(s.allowUseOfSshKey).toBe(true);
        expect(s.addAtDatabaseOpen).toBe(true);
        expect(s.removeAtDatabaseClose).toBe(false);
        expect(s.useConfirmConstraintWhenAdding).toBe(false);
        expect(s.lifetimeConstraintDuration).toBe(600);
        expect(s.selectedType).toBe('file');
        expect(s.fileName).toBe('C:\\keys\\id_rsa');
    });

    it('writes byte for byte what KeePassXC writes', () => {
        const s = SshAgentService.parseSettings(KEEPASSXC_RECORD)!;
        expect(SshAgentService.serializeSettings(s)).toBe(KEEPASSXC_RECORD);
    });

    it('survives a round trip for every field, escaping included', () => {
        const s = {
            ...ENABLED_KEEAGENT_SETTINGS('my <key> & "friends"'),
            useConfirmConstraintWhenAdding: true, useLifetimeConstraintWhenAdding: true, lifetimeConstraintDuration: 42,
            saveAttachmentToTempFile: true, fileName: 'a&b',
        };
        expect(SshAgentService.parseSettings(SshAgentService.serializeSettings(s))).toEqual(s);
    });

    it('rejects anything that is not a settings record', () => {
        expect(SshAgentService.parseSettings('')).toBeNull();
        expect(SshAgentService.parseSettings('<Other/>')).toBeNull();
        expect(SshAgentService.parseSettings('<EntrySettings><AllowUseOfSshKey>true</AllowUseOfSshKey>')).toBeNull();
        expect(SshAgentService.parseSettings(new Uint8Array([0, 1, 2, 255]))).toBeNull();
    });

    it('stores the record as an attachment and drops it when the settings are default', () => {
        const key = { name: 'id_ed25519', data: bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n') };
        const withRecord = SshAgentService.attachmentsWithSettings([key], ENABLED_KEEAGENT_SETTINGS('id_ed25519'));
        expect(withRecord.map(a => a.name)).toEqual(['id_ed25519', KEEAGENT_SETTINGS_ATTACHMENT]);
        expect(SshAgentService.readSettings({ attachments: withRecord })).toEqual(ENABLED_KEEAGENT_SETTINGS('id_ed25519'));
        expect(SshAgentService.isConfigured({ attachments: withRecord })).toBe(true);

        const cleared = SshAgentService.attachmentsWithSettings(withRecord, { ...DEFAULT_KEEAGENT_SETTINGS });
        expect(cleared.map(a => a.name)).toEqual(['id_ed25519']);
        expect(SshAgentService.attachmentsWithSettings(withRecord, null).map(a => a.name)).toEqual(['id_ed25519']);
        expect(SshAgentService.isConfigured({ attachments: cleared })).toBe(false);
    });

    it('offers attachments that are named like keys or start with a PEM banner', () => {
        const attachments = [
            { name: 'id_rsa', data: bytes('junk that is long enough') },
            { name: 'server.pem', data: bytes('junk that is long enough') },
            { name: 'notes.txt', data: bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END') },
            { name: 'photo.jpg', data: new Uint8Array(64).fill(1).buffer },
            { name: KEEAGENT_SETTINGS_ATTACHMENT, data: bytes(KEEPASSXC_RECORD) },
        ];
        expect(SshAgentService.keyCandidates({ attachments }).map(a => a.name)).toEqual(['id_rsa', 'server.pem', 'notes.txt']);
    });
});

describe('adding keys on unlock', () => {
    const calls: any[] = [];
    beforeEach(() => {
        calls.length = 0;
        (window as any).electron = {
            sshAgentAddKey: vi.fn(async (data: Uint8Array, passphrase: string, options: any) => {
                calls.push({ size: data.byteLength, passphrase, options });
                return passphrase === 'bad' ? { success: false, error: 'Wrong passphrase', code: 'passphrase' } : { success: true, fingerprint: 'SHA256:x' };
            }),
            sshAgentRemoveKey: vi.fn(async () => ({ success: true })),
        };
        userSettingsService.setSshAgentEnabled(true);
    });

    const database = (...entries: any[]): any => ({
        name: 'v', root: { id: 'r', name: 'Root', groups: [{ id: 'bin', name: 'Bin', isRecycleBin: true, groups: [], entries: [entries[0]] }], entries },
        groups: [],
    });

    it('sends the key bytes, the entry password and the record\'s options, and skips entries that opted out', async () => {
        const keyData = bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
        const wanted = entryWith(SshAgentService.attachmentsWithSettings([{ name: 'id_ed25519', data: keyData }], {
            ...ENABLED_KEEAGENT_SETTINGS('id_ed25519'), useConfirmConstraintWhenAdding: true, useLifetimeConstraintWhenAdding: true, lifetimeConstraintDuration: 300,
        }), kdbxweb.ProtectedValue.fromString('secret'));
        const manual = entryWith(SshAgentService.attachmentsWithSettings([{ name: 'id_ed25519', data: keyData }], {
            ...ENABLED_KEEAGENT_SETTINGS('id_ed25519'), addAtDatabaseOpen: false,
        }));
        const external = entryWith(SshAgentService.attachmentsWithSettings([], { ...DEFAULT_KEEAGENT_SETTINGS, allowUseOfSshKey: true, addAtDatabaseOpen: true, fileName: '/x' }));
        const plain = entryWith([{ name: 'id_ed25519', data: keyData }]);

        const report = await SshAgentService.addKeysOnUnlock(database(wanted, manual, external, plain));
        expect(report).toEqual({ added: 1, failed: [] });
        expect(calls).toEqual([{
            size: keyData.byteLength, passphrase: 'secret',
            options: { comment: 'deploy@id_ed25519', confirm: true, lifetimeSeconds: 300, removeAtClose: true },
        }]);
    });

    it('reports a failing entry by title and carries on with the rest', async () => {
        const keyData = bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
        const bad = { ...entryWith(SshAgentService.attachmentsWithSettings([{ name: 'k', data: keyData }], ENABLED_KEEAGENT_SETTINGS('k')), 'bad'), title: 'Broken' };
        const good = entryWith(SshAgentService.attachmentsWithSettings([{ name: 'k', data: keyData }], ENABLED_KEEAGENT_SETTINGS('k')));
        const missing = { ...entryWith(SshAgentService.attachmentsWithSettings([], ENABLED_KEEAGENT_SETTINGS('gone'))), title: 'Missing' };
        const report = await SshAgentService.addKeysOnUnlock(database(bad, good, missing));
        expect(report.added).toBe(1);
        expect(report.failed).toEqual([
            { title: 'Broken', error: 'Wrong passphrase' },
            { title: 'Missing', error: 'Attachment gone is missing' },
        ]);
    });

    it('does nothing while the setting is off', async () => {
        userSettingsService.setSshAgentEnabled(false);
        const keyData = bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END');
        const wanted = entryWith(SshAgentService.attachmentsWithSettings([{ name: 'k', data: keyData }], ENABLED_KEEAGENT_SETTINGS('k')));
        expect(await SshAgentService.addKeysOnUnlock(database(wanted))).toEqual({ added: 0, failed: [] });
        expect(calls).toEqual([]);
    });
});

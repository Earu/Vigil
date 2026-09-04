import * as kdbxweb from 'kdbxweb';
import { Entry, Attachment, Database } from '../types/database';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { userSettingsService } from './UserSettingsService';

// SSH keys stored on entries, the KeeAgent way: the private key is an
// attachment, its passphrase is the entry's password, and an attachment
// named KeeAgent.settings carries an XML record saying which attachment and
// how the agent should hold it. KeePassXC reads and writes the same record,
// so an entry configured in either app works in the other.
//
// The main process does the parsing and talks to the agent (ssh-agent.ts);
// this side decides which entries take part and what to send.

export const KEEAGENT_SETTINGS_ATTACHMENT = 'KeeAgent.settings';

export interface KeeAgentSettings {
    allowUseOfSshKey: boolean;
    addAtDatabaseOpen: boolean;
    removeAtDatabaseClose: boolean;
    useConfirmConstraintWhenAdding: boolean;
    useLifetimeConstraintWhenAdding: boolean;
    lifetimeConstraintDuration: number;
    // 'file' points at a path outside the vault. Vigil reads attachments
    // only; a file entry is shown as such and left alone
    selectedType: 'attachment' | 'file';
    attachmentName: string;
    saveAttachmentToTempFile: boolean;
    fileName: string;
}

// KeePassXC's KeeAgentSettings::reset
export const DEFAULT_KEEAGENT_SETTINGS: KeeAgentSettings = {
    allowUseOfSshKey: false,
    addAtDatabaseOpen: false,
    removeAtDatabaseClose: false,
    useConfirmConstraintWhenAdding: false,
    useLifetimeConstraintWhenAdding: false,
    lifetimeConstraintDuration: 600,
    selectedType: 'file',
    attachmentName: '',
    saveAttachmentToTempFile: false,
    fileName: '',
};

// What a freshly enabled entry gets: the key goes in on unlock and comes
// out on lock, which is the arrangement that leaves nothing behind
export const ENABLED_KEEAGENT_SETTINGS = (attachmentName: string): KeeAgentSettings => ({
    ...DEFAULT_KEEAGENT_SETTINGS,
    allowUseOfSshKey: true,
    addAtDatabaseOpen: true,
    removeAtDatabaseClose: true,
    selectedType: 'attachment',
    attachmentName,
});

export interface SshKeyResult {
    success: boolean;
    fingerprint?: string;
    error?: string;
}

export interface UnlockReport {
    added: number;
    failed: Array<{ title: string; error: string }>;
}

const KEY_NAME_HINT = /(^|[/._-])(id_[a-z0-9]+|.*\.(pem|key|ppk|openssh))$/i;

export class SshAgentService {
    private static readBool(node: Element | null): boolean | undefined {
        if (!node) return undefined;
        return /^\s*t/i.test(node.textContent ?? '');
    }

    private static readText(node: Element | null): string | undefined {
        if (!node) return undefined;
        return node.textContent ?? '';
    }

    private static child(parent: Element | null, name: string): Element | null {
        if (!parent) return null;
        for (const node of Array.from(parent.children)) {
            if (node.localName === name) return node;
        }
        return null;
    }

    static parseSettings(source: string | Uint8Array): KeeAgentSettings | null {
        const xml = typeof source === 'string' ? source : new TextDecoder('utf-8').decode(source).replace(/^﻿/, '');
        let root: Element | null;
        try {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            root = doc.documentElement;
            if (!root || root.localName !== 'EntrySettings' || doc.getElementsByTagName('parsererror').length > 0) return null;
        } catch {
            return null;
        }
        const s = { ...DEFAULT_KEEAGENT_SETTINGS };
        s.allowUseOfSshKey = this.readBool(this.child(root, 'AllowUseOfSshKey')) ?? s.allowUseOfSshKey;
        s.addAtDatabaseOpen = this.readBool(this.child(root, 'AddAtDatabaseOpen')) ?? s.addAtDatabaseOpen;
        s.removeAtDatabaseClose = this.readBool(this.child(root, 'RemoveAtDatabaseClose')) ?? s.removeAtDatabaseClose;
        s.useConfirmConstraintWhenAdding = this.readBool(this.child(root, 'UseConfirmConstraintWhenAdding')) ?? s.useConfirmConstraintWhenAdding;
        s.useLifetimeConstraintWhenAdding = this.readBool(this.child(root, 'UseLifetimeConstraintWhenAdding')) ?? s.useLifetimeConstraintWhenAdding;
        const lifetime = parseInt(this.readText(this.child(root, 'LifetimeConstraintDuration')) ?? '', 10);
        if (Number.isFinite(lifetime) && lifetime > 0) s.lifetimeConstraintDuration = lifetime;
        const location = this.child(root, 'Location');
        const type = this.readText(this.child(location, 'SelectedType'));
        s.selectedType = type === 'attachment' ? 'attachment' : 'file';
        s.attachmentName = this.readText(this.child(location, 'AttachmentName')) ?? '';
        s.saveAttachmentToTempFile = this.readBool(this.child(location, 'SaveAttachmentToTempFile')) ?? false;
        s.fileName = this.readText(this.child(location, 'FileName')) ?? '';
        return s;
    }

    // The layout KeePassXC writes, so a diff between the two apps is empty
    static serializeSettings(s: KeeAgentSettings): string {
        const escape = (value: string) => value
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const bool = (value: boolean) => (value ? 'true' : 'false');
        const text = (name: string, value: string) => (value ? `<${name}>${escape(value)}</${name}>` : `<${name}/>`);
        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<EntrySettings xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
            `  <AllowUseOfSshKey>${bool(s.allowUseOfSshKey)}</AllowUseOfSshKey>`,
            `  <AddAtDatabaseOpen>${bool(s.addAtDatabaseOpen)}</AddAtDatabaseOpen>`,
            `  <RemoveAtDatabaseClose>${bool(s.removeAtDatabaseClose)}</RemoveAtDatabaseClose>`,
            `  <UseConfirmConstraintWhenAdding>${bool(s.useConfirmConstraintWhenAdding)}</UseConfirmConstraintWhenAdding>`,
            `  <UseLifetimeConstraintWhenAdding>${bool(s.useLifetimeConstraintWhenAdding)}</UseLifetimeConstraintWhenAdding>`,
            `  <LifetimeConstraintDuration>${Math.max(1, Math.floor(s.lifetimeConstraintDuration))}</LifetimeConstraintDuration>`,
            '  <Location>',
            `    <SelectedType>${s.selectedType}</SelectedType>`,
            `    ${text('AttachmentName', s.attachmentName)}`,
            `    <SaveAttachmentToTempFile>${bool(s.saveAttachmentToTempFile)}</SaveAttachmentToTempFile>`,
            `    ${text('FileName', s.fileName)}`,
            '  </Location>',
            '</EntrySettings>',
            '',
        ].join('\n');
    }

    static isDefault(s: KeeAgentSettings): boolean {
        return (Object.keys(DEFAULT_KEEAGENT_SETTINGS) as Array<keyof KeeAgentSettings>)
            .every(key => s[key] === DEFAULT_KEEAGENT_SETTINGS[key]);
    }

    static readSettings(entry: Pick<Entry, 'attachments'>): KeeAgentSettings | null {
        const record = entry.attachments.find(a => a.name === KEEAGENT_SETTINGS_ATTACHMENT);
        if (!record) return null;
        return this.parseSettings(KeepassDatabaseService.getAttachmentBytes(record));
    }

    // The entry's attachments with the settings record written, or removed
    // when the settings are the defaults (KeePassXC does the same, so an
    // entry that stops using a key carries no trace of having done so)
    static attachmentsWithSettings(attachments: Attachment[], settings: KeeAgentSettings | null): Attachment[] {
        const rest = attachments.filter(a => a.name !== KEEAGENT_SETTINGS_ATTACHMENT);
        if (!settings || this.isDefault(settings)) return rest;
        const bytes = new TextEncoder().encode(this.serializeSettings(settings));
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return [...rest, { name: KEEAGENT_SETTINGS_ATTACHMENT, data }];
    }

    // Whether the record for this entry would say anything at all
    static isConfigured(entry: Pick<Entry, 'attachments'>): boolean {
        const settings = this.readSettings(entry);
        return !!settings && settings.allowUseOfSshKey;
    }

    static keyAttachment(entry: Pick<Entry, 'attachments'>, settings: KeeAgentSettings | null): Attachment | undefined {
        if (!settings || settings.selectedType !== 'attachment' || !settings.attachmentName) return undefined;
        return entry.attachments.find(a => a.name === settings.attachmentName);
    }

    // Attachments worth offering as the key: named like one, or starting
    // with a PEM banner
    static keyCandidates(entry: Pick<Entry, 'attachments'>): Attachment[] {
        return entry.attachments.filter(a => {
            if (a.name === KEEAGENT_SETTINGS_ATTACHMENT) return false;
            if (KEY_NAME_HINT.test(a.name)) return true;
            const bytes = KeepassDatabaseService.getAttachmentBytes(a);
            if (bytes.byteLength < 16 || bytes.byteLength > 1024 * 1024) return false;
            const head = new TextDecoder('latin1').decode(bytes.subarray(0, 40));
            return head.startsWith('-----BEGIN') || head.startsWith('PuTTY-User-Key-File');
        });
    }

    static passphraseOf(entry: Pick<Entry, 'password'>): string {
        return entry.password instanceof kdbxweb.ProtectedValue ? entry.password.getText() : (entry.password ?? '');
    }

    static defaultComment(entry: Pick<Entry, 'username'>, attachmentName: string): string {
        return `${entry.username ?? ''}@${attachmentName}`;
    }

    private static failure(error: string): SshKeyResult {
        return { success: false, error };
    }

    static async addEntryKey(entry: Entry, settings = this.readSettings(entry)): Promise<SshKeyResult> {
        if (!window.electron) return this.failure('SSH agent support needs the desktop app');
        if (!settings) return this.failure('No SSH key is configured on this entry');
        if (settings.selectedType !== 'attachment') return this.failure('This entry points at a key file outside the vault, which Vigil does not read');
        const attachment = this.keyAttachment(entry, settings);
        if (!attachment) return this.failure(`Attachment ${settings.attachmentName} is missing`);
        const result = await window.electron.sshAgentAddKey(
            KeepassDatabaseService.getAttachmentBytes(attachment),
            this.passphraseOf(entry),
            {
                comment: this.defaultComment(entry, attachment.name),
                confirm: settings.useConfirmConstraintWhenAdding,
                lifetimeSeconds: settings.useLifetimeConstraintWhenAdding ? settings.lifetimeConstraintDuration : undefined,
                removeAtClose: settings.removeAtDatabaseClose,
            }
        );
        return result.success ? { success: true, fingerprint: result.fingerprint } : this.failure(result.error);
    }

    static async removeEntryKey(entry: Entry, settings = this.readSettings(entry)): Promise<SshKeyResult> {
        if (!window.electron) return this.failure('SSH agent support needs the desktop app');
        const attachment = this.keyAttachment(entry, settings);
        if (!attachment) return this.failure('No SSH key is configured on this entry');
        const result = await window.electron.sshAgentRemoveKey(KeepassDatabaseService.getAttachmentBytes(attachment), this.passphraseOf(entry));
        return result.success ? { success: true } : this.failure(result.error);
    }

    // Every entry that asked to be added at open, in one pass. Failures are
    // collected rather than thrown: one bad key must not keep the rest out
    static async addKeysOnUnlock(database: Database): Promise<UnlockReport> {
        const report: UnlockReport = { added: 0, failed: [] };
        if (!userSettingsService.getSshAgentEnabled() || !window.electron) return report;
        for (const entry of KeepassDatabaseService.getAllEntriesFromGroup(database.root)) {
            if (!entry.attachments.some(a => a.name === KEEAGENT_SETTINGS_ATTACHMENT)) continue;
            const settings = this.readSettings(entry);
            if (!settings || !settings.allowUseOfSshKey || !settings.addAtDatabaseOpen) continue;
            if (settings.selectedType !== 'attachment') continue;
            const result = await this.addEntryKey(entry, settings);
            if (result.success) report.added++;
            else report.failed.push({ title: entry.title || '(untitled)', error: result.error ?? 'failed' });
        }
        return report;
    }
}

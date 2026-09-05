import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// An attachment's name is written by whoever wrote the entry, and a vault
// may be shared. The save dialog must see a file name, never a path

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-attach-names-'));
let dialogOptions: Electron.SaveDialogOptions | undefined;

vi.mock('electron', () => ({
    app: { getPath: () => tmpRoot },
    dialog: {
        showSaveDialog: async (options: Electron.SaveDialogOptions) => {
            dialogOptions = options;
            return { canceled: true };
        },
    },
    shell: {},
    BrowserWindow: { getAllWindows: () => [] },
}));

const { attachmentFileName, saveAttachment, saveKeyFile } = await import('../electron/src/file-operations');

describe('attachmentFileName', () => {
    it.each([
        ['report.pdf', 'report.pdf'],
        ['../../.ssh/authorized_keys', 'authorized_keys'],
        ['/etc/passwd', 'passwd'],
        ['C:\\Users\\ryan\\.ssh\\id_ed25519', 'id_ed25519'],
        ['name\x00.txt', 'name.txt'],
        ['  spaced .txt  ', 'spaced .txt'],
        ['', 'attachment'],
        ['.', 'attachment'],
        ['..', 'attachment'],
        ['/', 'attachment'],
        ['.hidden', '.hidden'],
    ])('%j becomes %j', (input, expected) => {
        expect(attachmentFileName(input)).toBe(expected);
    });

    it('takes nothing but a string', () => {
        for (const value of [undefined, null, 42, {}, ['a.txt'], () => 'x']) {
            expect(attachmentFileName(value)).toBe('attachment');
        }
    });

    it('caps the length', () => {
        expect(attachmentFileName('a'.repeat(400)).length).toBe(255);
    });
});

describe('the save dialog', () => {
    it('is offered the cleaned name for attachments', async () => {
        await saveAttachment('../../evil', new Uint8Array([1]));
        expect(dialogOptions?.defaultPath).toBe('evil');
        expect(dialogOptions?.filters).toBeUndefined();
    });

    it('is offered key file filters for key files', async () => {
        await saveKeyFile('/tmp/vault.keyx', new Uint8Array([1]));
        expect(dialogOptions?.defaultPath).toBe('vault.keyx');
        expect(dialogOptions?.filters?.[0].extensions).toContain('keyx');
    });

    it('is never opened for data that is not bytes', async () => {
        dialogOptions = undefined;
        expect(await saveAttachment('x', 'not bytes' as unknown as Uint8Array)).toEqual({ success: false, error: 'Failed to save file' });
        expect(dialogOptions).toBeUndefined();
    });
});

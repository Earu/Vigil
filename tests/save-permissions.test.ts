import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A vault is the most sensitive file the app owns. Saving it must not widen
// who can read it: the atomic write goes through a temp file, and a temp file
// created at the umask default is 0644 on a typical setup, which the rename
// would then carry onto a database the user deliberately kept at 0600.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-perms-'));

// Where the save dialog will claim the user pointed; set per test
let chosenPath: string | undefined;

vi.mock('electron', () => ({
    app: { getPath: () => tmpRoot },
    dialog: { showSaveDialog: async () => ({ filePath: chosenPath, canceled: !chosenPath }) },
    BrowserWindow: {},
}));

const { saveToFile, saveAttachment } = await import('../electron/src/file-operations');

const mode = (file: string): string => (fs.statSync(file).mode & 0o777).toString(8);

let counter = 0;
const vaultPath = () => path.join(tmpRoot, `vault-${counter++}.kdbx`);

beforeEach(() => {
    process.umask(0o022);
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('vault file permissions', () => {
    it('keeps a private vault private across a save', async () => {
        const file = vaultPath();
        fs.writeFileSync(file, 'original', { mode: 0o600 });

        expect(await saveToFile(file, new Uint8Array([1, 2, 3]))).toEqual({ success: true });

        expect(mode(file)).toBe('600');
        expect(fs.readFileSync(file)).toEqual(Buffer.from([1, 2, 3]));
    });

    it('preserves a mode the umask would have narrowed', async () => {
        const file = vaultPath();
        fs.writeFileSync(file, 'original');
        fs.chmodSync(file, 0o660);

        await saveToFile(file, new Uint8Array([4]));

        expect(mode(file)).toBe('660');
    });

    it('creates a vault that did not exist as owner-only', async () => {
        const file = vaultPath();

        await saveToFile(file, new Uint8Array([5]));

        expect(mode(file)).toBe('600');
    });

    it('leaves no temp file behind', async () => {
        const file = vaultPath();
        await saveToFile(file, new Uint8Array([6]));

        const leftovers = fs.readdirSync(tmpRoot).filter(name => name.includes('.tmp-'));
        expect(leftovers).toEqual([]);
    });
});

// An attachment carries whatever the user put on the entry: an SSH key, a
// recovery kit, a scan of a passport. Exporting it must not drop it into the
// filesystem readable by every account on the machine.
describe.skipIf(process.platform === 'win32')('attachment file permissions', () => {
    it('writes an exported attachment owner-only', async () => {
        chosenPath = path.join(tmpRoot, 'exported-key.pem');

        const result = await saveAttachment('exported-key.pem', new Uint8Array([7, 8, 9]));

        expect(result.success).toBe(true);
        expect(mode(chosenPath)).toBe('600');
        expect(fs.readFileSync(chosenPath)).toEqual(Buffer.from([7, 8, 9]));
    });

    it('narrows a world-readable file it overwrites', async () => {
        chosenPath = path.join(tmpRoot, 'stale-export.bin');
        // A previous export from a build that wrote at the umask default
        fs.writeFileSync(chosenPath, 'old', { mode: 0o644 });

        await saveAttachment('stale-export.bin', new Uint8Array([1]));

        // The open mode alone would not do this: it is ignored for an
        // existing file, which is why the mode is set explicitly
        expect(mode(chosenPath)).toBe('600');
    });

    it('truncates rather than leaving a tail of the previous file', async () => {
        chosenPath = path.join(tmpRoot, 'shrinking.bin');
        fs.writeFileSync(chosenPath, Buffer.alloc(64, 0xaa));

        await saveAttachment('shrinking.bin', new Uint8Array([1, 2]));

        expect(fs.readFileSync(chosenPath)).toEqual(Buffer.from([1, 2]));
    });
});

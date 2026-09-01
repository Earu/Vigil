import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A vault is the most sensitive file the app owns. Saving it must not widen
// who can read it: the atomic write goes through a temp file, and a temp file
// created at the umask default is 0644 on a typical setup, which the rename
// would then carry onto a database the user deliberately kept at 0600.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-perms-'));

vi.mock('electron', () => ({
    app: { getPath: () => tmpRoot },
    dialog: {},
    BrowserWindow: {},
}));

const { saveToFile } = await import('../electron/src/file-operations');

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

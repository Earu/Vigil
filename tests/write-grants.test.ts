import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Which flows hand out write authority. Only vault paths may be written by
// save-to-file; a key file or attachment destination stays readable only.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-write-grants-'));
const userData = path.join(tmpRoot, 'userData');
fs.mkdirSync(userData, { recursive: true });

// What the dialogs will claim the user pointed at; set per test
let openPaths: string[] = [];
let savePath: string | undefined;

vi.mock('electron', () => ({
    app: { getPath: () => userData },
    dialog: {
        showOpenDialog: async () => ({ filePaths: openPaths, canceled: openPaths.length === 0 }),
        showSaveDialog: async () => ({ filePath: savePath, canceled: !savePath }),
    },
    shell: {},
    BrowserWindow: { getAllWindows: () => [] },
}));

const authority = await import('../electron/src/path-authority');
const fileOps = await import('../electron/src/file-operations');

const lastDbFile = path.join(userData, 'last_database.json');
const grantFile = path.join(userData, 'granted-paths.json');

let counter = 0;
const newFile = (name: string, contents = 'x'): string => {
    const file = path.join(tmpRoot, `${counter++}-${name}`);
    fs.writeFileSync(file, contents);
    return file;
};

beforeEach(() => {
    authority.resetForTests();
    fs.rmSync(grantFile, { force: true });
    fs.rmSync(lastDbFile, { force: true });
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('which flows grant writes', () => {
    it('a selected key file is readable but never writable', async () => {
        const keyFile = newFile('unlock.keyx');
        openPaths = [keyFile];
        const result = await fileOps.selectKeyFile();
        expect(result.filePath).toBe(keyFile);
        expect(authority.isPathGranted(keyFile)).toBe(true);
        expect(authority.isPathGranted(keyFile, { write: true })).toBe(false);
    });

    it('a saved attachment is readable but never writable', async () => {
        savePath = path.join(tmpRoot, 'exported.pem');
        await fileOps.saveAttachment('exported.pem', new Uint8Array([1]));
        expect(authority.isPathGranted(savePath)).toBe(true);
        expect(authority.isPathGranted(savePath, { write: true })).toBe(false);
    });

    it('an opened vault gets a write grant', async () => {
        const vault = newFile('opened.kdbx');
        openPaths = [vault];
        const result = await fileOps.openFile();
        expect(result.success).toBe(true);
        expect(authority.isPathGranted(vault, { write: true })).toBe(true);
    });

    it('a save-as vault gets a write grant', async () => {
        savePath = path.join(tmpRoot, 'created.kdbx');
        const result = await fileOps.saveFile(new Uint8Array([1, 2]));
        expect(result.success).toBe(true);
        expect(authority.isPathGranted(savePath, { write: true })).toBe(true);
    });

    it('the re-granted last database gets a write grant', async () => {
        const vault = newFile('remembered.kdbx');
        expect(await fileOps.saveLastDatabasePath(vault)).toBe(true);
        authority.resetForTests();
        expect(await fileOps.loadLastDatabasePath()).toBe(vault);
        expect(authority.isPathGranted(vault, { write: true })).toBe(true);
    });
});

describe('sidecar writes', () => {
    it.skipIf(process.platform === 'win32')('last_database.json lands owner-only with no temp file', async () => {
        process.umask(0o022);
        expect(await fileOps.saveLastDatabasePath('/vaults/a.kdbx')).toBe(true);
        expect(fs.statSync(lastDbFile).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(userData).filter(name => name.includes('.tmp-'))).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('granted-paths.json lands owner-only with no temp file', () => {
        process.umask(0o022);
        authority.grantPathPersistent('/keys/b.keyx');
        expect(fs.statSync(grantFile).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(userData).filter(name => name.includes('.tmp-'))).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('a failed rewrite leaves the previous record intact', async () => {
        expect(await fileOps.saveLastDatabasePath('/vaults/first.kdbx')).toBe(true);
        fs.chmodSync(userData, 0o555); // temp file creation must fail
        const result = await fileOps.saveLastDatabasePath('/vaults/second.kdbx');
        fs.chmodSync(userData, 0o755);

        expect(result).toBe(false);
        expect(JSON.parse(fs.readFileSync(lastDbFile, 'utf8'))).toEqual({ path: '/vaults/first.kdbx' });
        expect(fs.readdirSync(userData).filter(name => name.includes('.tmp-'))).toEqual([]);
    });
});

describe('directory sync after rename', () => {
    // A directory that cannot be opened for sync (Windows always, here a
    // dir with no read bit) must not fail a save that already landed
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a save still succeeds when the parent directory cannot be opened', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'no-read-'));
        const target = path.join(dir, 'vault.kdbx');
        fs.chmodSync(dir, 0o311); // traverse and write, no read: open(dir, 'r') fails

        const result = await fileOps.saveToFile(target, new Uint8Array([7, 7, 7]));
        fs.chmodSync(dir, 0o755);

        expect(result).toEqual({ success: true });
        expect(fs.readFileSync(target)).toEqual(Buffer.from([7, 7, 7]));
    });
});

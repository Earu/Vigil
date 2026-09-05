import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
    app: { getPath: () => tmpRoot },
    dialog: {},
    BrowserWindow: { getAllWindows: () => [] },
}));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-cloud-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const {
    icloudPlaceholder, isEvicted, materialize, cloudClientFor, describeReadFailure, setCloudDepsForTests,
} = await import('../electron/src/cloud-files');
const { readFile, statFile, loadLastDatabasePath, saveLastDatabasePath } = await import('../electron/src/file-operations');

afterEach(() => setCloudDepsForTests({}));

// iCloud Drive evicts a cold file to ".name.icloud"; the tests stage that
// layout on disk and stand in for brctl, which is not here

let counter = 0;
function evictedVault(): { file: string; placeholder: string } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `v${counter++}-`));
    const file = path.join(dir, 'vault.kdbx');
    const placeholder = icloudPlaceholder(file);
    fs.writeFileSync(placeholder, '<plist/>');
    return { file, placeholder };
}

// A download that lands the bytes and removes the placeholder, like bird does
const landing = (contents: string) => async (file: string) => {
    fs.writeFileSync(file, contents);
    fs.unlinkSync(icloudPlaceholder(file));
};

describe('detecting an evicted iCloud file', () => {
    it('names the placeholder beside the file', () => {
        expect(icloudPlaceholder('/x/Vault Docs/vault.kdbx')).toBe('/x/Vault Docs/.vault.kdbx.icloud');
    });

    it('is the placeholder present and the file absent, on macOS', async () => {
        const { file } = evictedVault();
        expect(await isEvicted(file, { platform: 'darwin' })).toBe(true);
        expect(await isEvicted(file, { platform: 'linux' })).toBe(false);
        expect(await isEvicted(file, { platform: 'win32' })).toBe(false);
    });

    it('is false for a present file, even with a stale placeholder', async () => {
        const { file } = evictedVault();
        fs.writeFileSync(file, 'bytes');
        expect(await isEvicted(file, { platform: 'darwin' })).toBe(false);
    });

    it('is false for a file that is simply missing', async () => {
        expect(await isEvicted(path.join(tmpRoot, 'nope.kdbx'), { platform: 'darwin' })).toBe(false);
    });
});

describe('materialize', () => {
    it('returns at once for a present file without asking for a download', async () => {
        const download = vi.fn();
        const file = path.join(tmpRoot, 'present.kdbx');
        fs.writeFileSync(file, 'x');
        expect(await materialize(file, { platform: 'darwin', download })).toEqual({ ok: true });
        expect(download).not.toHaveBeenCalled();
    });

    it('asks for the download and waits until the file appears', async () => {
        const { file } = evictedVault();
        let polls = 0;
        const download = vi.fn(async () => {});
        const result = await materialize(file, {
            platform: 'darwin',
            download,
            sleep: async () => { if (++polls === 3) fs.writeFileSync(file, 'landed'); },
        });
        expect(result).toEqual({ ok: true });
        expect(download).toHaveBeenCalledWith(file);
        expect(polls).toBe(3);
    });

    it('gives up after the timeout and says the download is still running', async () => {
        const { file } = evictedVault();
        let now = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const result = await materialize(file, {
                platform: 'darwin',
                download: async () => {},
                sleep: async () => { now += 10_000; },
                timeoutMs: 30_000,
            });
            expect(result).toEqual({ ok: false, error: 'vault.kdbx is stored in iCloud Drive and has not finished downloading. Try again in a moment' });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('reports a download request that fails', async () => {
        const { file } = evictedVault();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const result = await materialize(file, {
                platform: 'darwin',
                download: async () => { throw new Error('spawn brctl ENOENT'); },
            });
            expect(result).toEqual({ ok: false, error: 'vault.kdbx is stored in iCloud Drive and could not be downloaded' });
        } finally {
            error.mockRestore();
        }
    });
});

describe('file operations on an evicted vault', () => {
    it('read-file downloads it and returns the bytes', async () => {
        const { file } = evictedVault();
        setCloudDepsForTests({ platform: 'darwin', download: landing('the vault'), sleep: async () => {} });
        const result = await readFile(file);
        expect(result.success).toBe(true);
        expect(result.data?.toString()).toBe('the vault');
    });

    it('read-file passes the download failure on', async () => {
        const { file } = evictedVault();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        setCloudDepsForTests({ platform: 'darwin', download: async () => { throw new Error('offline'); } });
        try {
            expect(await readFile(file)).toEqual({ success: false, error: 'vault.kdbx is stored in iCloud Drive and could not be downloaded' });
        } finally {
            error.mockRestore();
        }
    });

    it('stat-file downloads it too, so the save-time baseline sees the real file', async () => {
        const { file } = evictedVault();
        setCloudDepsForTests({ platform: 'darwin', download: landing('abc'), sleep: async () => {} });
        const result = await statFile(file);
        expect(result.success).toBe(true);
        expect(result.size).toBe(3);
    });

    it('the remembered vault survives eviction', async () => {
        const { file } = evictedVault();
        setCloudDepsForTests({ platform: 'darwin' });
        expect(await saveLastDatabasePath(file)).toBe(true);
        expect(await loadLastDatabasePath()).toBe(file);
    });

    it('a remembered vault that is plainly gone is still forgotten', async () => {
        const gone = path.join(tmpRoot, 'gone.kdbx');
        setCloudDepsForTests({ platform: 'darwin' });
        expect(await saveLastDatabasePath(gone)).toBe(true);
        expect(await loadLastDatabasePath()).toBeNull();
    });
});

describe('naming the client behind a failed read', () => {
    const home = '/Users/ryan';
    const mac = { platform: 'darwin' as const, homedir: home };

    it('knows the macOS roots', () => {
        expect(cloudClientFor(`${home}/Library/Mobile Documents/com~apple~CloudDocs/vault.kdbx`, mac)).toBe('iCloud Drive');
        expect(cloudClientFor(`${home}/Library/CloudStorage/Dropbox/vault.kdbx`, mac)).toBe('Dropbox');
        expect(cloudClientFor(`${home}/Library/CloudStorage/GoogleDrive-ryan@example.com/My Drive/vault.kdbx`, mac)).toBe('Google Drive');
        expect(cloudClientFor(`${home}/Library/CloudStorage/OneDrive-Personal/vault.kdbx`, mac)).toBe('OneDrive');
        expect(cloudClientFor(`${home}/Documents/vault.kdbx`, mac)).toBeNull();
        expect(cloudClientFor(`${home}/Library/CloudStorage`, mac)).toBeNull();
    });

    it('knows the Windows roots', () => {
        const win = { platform: 'win32' as const, homedir: 'C:\\Users\\ryan', env: { OneDrive: 'C:\\Users\\ryan\\OneDrive' } };
        expect(cloudClientFor('C:\\Users\\ryan\\OneDrive\\vault.kdbx', win)).toBe('OneDrive');
        expect(cloudClientFor('C:\\Users\\ryan\\iCloudDrive\\vault.kdbx', win)).toBe('iCloud Drive');
        expect(cloudClientFor('C:\\Users\\ryan\\Documents\\vault.kdbx', win)).toBeNull();
        expect(cloudClientFor('C:\\Users\\ryan\\OneDrive\\vault.kdbx', { ...win, env: {} })).toBeNull();
    });

    it('knows an rclone mount on Linux from the mount table', () => {
        const mounts = () => [
            'proc /proc proc rw,nosuid 0 0',
            'icloud: /home/ryan/iCloudDrive fuse.rclone rw,nosuid,nodev,relatime,user_id=1000 0 0',
            'gdrive: /home/ryan/Google\\040Drive fuse.rclone rw 0 0',
            'server:/srv /home/ryan/nas fuse.sshfs rw 0 0',
        ].join('\n');
        const linux = { platform: 'linux' as const, homedir: '/home/ryan', mounts };
        expect(cloudClientFor('/home/ryan/iCloudDrive/PERSONAL/VAULT.kdbx', linux)).toBe('rclone');
        expect(cloudClientFor('/home/ryan/Google Drive/vault.kdbx', linux)).toBe('rclone');
        expect(cloudClientFor('/home/ryan/nas/vault.kdbx', linux)).toBeNull();
        expect(cloudClientFor('/home/ryan/iCloudDrive', linux)).toBeNull();
        expect(cloudClientFor('/home/ryan/iCloudDriveOld/vault.kdbx', linux)).toBeNull();
    });

    it('blames the download only for errors a local disk would not give', () => {
        const file = `${home}/Library/CloudStorage/Dropbox/vault.kdbx`;
        expect(describeReadFailure(file, Object.assign(new Error(), { code: 'UNKNOWN' }), mac))
            .toBe('vault.kdbx is stored online by Dropbox and could not be downloaded');
        expect(describeReadFailure(file, Object.assign(new Error(), { code: 'EACCES' }), mac)).toBe('Failed to read file');
        expect(describeReadFailure(`${home}/vault.kdbx`, Object.assign(new Error(), { code: 'UNKNOWN' }), mac)).toBe('Failed to read file');
    });
});

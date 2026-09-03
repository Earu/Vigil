import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The save path merges external changes into memory before overwriting the
// file, so a merge that resolves badly destroys the only copy. These are the
// copies to fall back to.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-backups-'));
const userData = path.join(tmpRoot, 'userData');

vi.mock('electron', () => ({
    app: { getPath: () => userData },
    dialog: {},
    shell: { openPath: async () => '' },
    BrowserWindow: {},
}));

const { backupBeforeWrite, listBackups, backupDir, getBackupInfo } =
    await import('../electron/src/backups');
const { saveToFile } = await import('../electron/src/file-operations');

const ON = { enabled: true, keep: 3 };
const HALF_HOUR = 30 * 60 * 1000;

let counter = 0;
const newVault = (contents = 'v1'): string => {
    const file = path.join(tmpRoot, `vault-${counter++}.kdbx`);
    fs.writeFileSync(file, contents, { mode: 0o600 });
    return file;
};

// The interval check reads the newest backup's mtime, so ageing it is how a
// test says "that copy was taken a while ago"
const age = (file: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(file, when, when);
};

beforeEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('vault backups', () => {
    it('copies the file that is about to be overwritten', async () => {
        const vault = newVault('before the overwrite');

        await backupBeforeWrite(vault, ON);

        const backups = await listBackups(vault);
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(backups[0], 'utf8')).toBe('before the overwrite');
    });

    it('has nothing to preserve on the first write to a path', async () => {
        const vault = path.join(tmpRoot, 'does-not-exist-yet.kdbx');

        await backupBeforeWrite(vault, ON);

        expect(await listBackups(vault)).toHaveLength(0);
    });

    it('does nothing when backups are switched off', async () => {
        const vault = newVault();

        await backupBeforeWrite(vault, { enabled: false, keep: 3 });

        expect(await listBackups(vault)).toHaveLength(0);
    });

    it('spaces copies out instead of taking one per save', async () => {
        const vault = newVault();

        await backupBeforeWrite(vault, ON);
        await backupBeforeWrite(vault, ON);
        await backupBeforeWrite(vault, ON);

        // Three saves in quick succession, one copy: three copies from the
        // same minute would all be from after whatever went wrong
        expect(await listBackups(vault)).toHaveLength(1);
    });

    it('takes a fresh copy once the gap has passed', async () => {
        const vault = newVault('first');
        await backupBeforeWrite(vault, ON);
        age((await listBackups(vault))[0], HALF_HOUR + 1000);

        fs.writeFileSync(vault, 'second');
        await backupBeforeWrite(vault, ON);

        const backups = await listBackups(vault);
        expect(backups).toHaveLength(2);
        expect(backups.map(f => fs.readFileSync(f, 'utf8'))).toEqual(['first', 'second']);
    });

    it('keeps only the newest copies', async () => {
        const vault = newVault();

        for (let i = 0; i < 6; i++) {
            fs.writeFileSync(vault, `version ${i}`);
            await backupBeforeWrite(vault, ON);
            const all = await listBackups(vault);
            all.forEach(file => age(file, HALF_HOUR + 1000));
        }

        const backups = await listBackups(vault);
        expect(backups).toHaveLength(ON.keep);
        // The oldest were dropped, the newest survived
        expect(backups.map(f => fs.readFileSync(f, 'utf8'))).toEqual(['version 3', 'version 4', 'version 5']);
    });

    it('copies even inside the gap when it is replacing someone else version', async () => {
        const vault = newVault('the other machine version');
        await backupBeforeWrite(vault, ON);
        expect(await listBackups(vault)).toHaveLength(1);

        // A save that merges, or that overwrites after a failed merge, is
        // about to destroy the only record of what was on disk. Spacing must
        // not swallow that one
        fs.writeFileSync(vault, 'changed by the other machine');
        await backupBeforeWrite(vault, { ...ON, replacingExternalChanges: true });

        const backups = await listBackups(vault);
        expect(backups).toHaveLength(2);
        expect(fs.readFileSync(backups[1], 'utf8')).toBe('changed by the other machine');
    });

    it('still respects the off switch when replacing external changes', async () => {
        const vault = newVault();

        await backupBeforeWrite(vault, { enabled: false, keep: 3, replacingExternalChanges: true });

        expect(await listBackups(vault)).toHaveLength(0);
    });

    it('never keeps fewer than one, whatever it is asked for', async () => {
        const vault = newVault();

        await backupBeforeWrite(vault, { enabled: true, keep: 0 });

        expect(await listBackups(vault)).toHaveLength(1);
    });

    it('does not make a copy more readable than the vault', async () => {
        const vault = newVault();
        fs.chmodSync(vault, 0o600);

        await backupBeforeWrite(vault, ON);

        const [backup] = await listBackups(vault);
        expect((fs.statSync(backup).mode & 0o777).toString(8)).toBe('600');
    });

    it('creates the backup directory owner-only', async () => {
        process.umask(0o022);
        const vault = newVault();

        await backupBeforeWrite(vault, ON);

        expect((fs.statSync(backupDir(vault)).mode & 0o777).toString(8)).toBe('700');
    });

    it('a failed chmod still leaves the copy no wider than the vault', async () => {
        // The copy is created at the vault's mode (umask can only subtract),
        // so the chmod is a fix-up rather than the only thing standing
        // between a 0600 vault and a 0644 backup
        process.umask(0o022);
        const vault = newVault();
        fs.chmodSync(vault, 0o600);
        const spy = vi.spyOn(fs.promises, 'chmod').mockRejectedValue(new Error('denied'));

        await backupBeforeWrite(vault, ON);
        spy.mockRestore();

        const [backup] = await listBackups(vault);
        expect((fs.statSync(backup).mode & 0o777).toString(8)).toBe('600');
    });

    it('keeps two vaults of the same name apart', async () => {
        const a = path.join(fs.mkdtempSync(path.join(tmpRoot, 'a-')), 'vault.kdbx');
        const b = path.join(fs.mkdtempSync(path.join(tmpRoot, 'b-')), 'vault.kdbx');
        fs.writeFileSync(a, 'from a');
        fs.writeFileSync(b, 'from b');

        await backupBeforeWrite(a, ON);
        await backupBeforeWrite(b, ON);

        expect(backupDir(a)).not.toBe(backupDir(b));
        expect(fs.readFileSync((await listBackups(a))[0], 'utf8')).toBe('from a');
        expect(fs.readFileSync((await listBackups(b))[0], 'utf8')).toBe('from b');
    });

    it('reports what is stored', async () => {
        const vault = newVault('some bytes');
        await backupBeforeWrite(vault, ON);

        const info = await getBackupInfo(vault);
        expect(info.count).toBe(1);
        expect(info.totalBytes).toBe('some bytes'.length);
        expect(info.newest).not.toBeNull();
        expect(info.directory).toBe(backupDir(vault));
    });

    it('saves the vault even when the backup cannot be written', async () => {
        const vault = newVault('original');
        // A file where the backups directory needs to be, so mkdir fails
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(path.join(userData, 'backups'), 'in the way');

        const result = await saveToFile(vault, new Uint8Array([1, 2, 3]), ON);

        expect(result).toEqual({ success: true });
        expect(fs.readFileSync(vault)).toEqual(Buffer.from([1, 2, 3]));
    });
});

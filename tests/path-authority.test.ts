import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-paths-'));
vi.mock('electron', () => ({
    app: { getPath: () => userData },
    dialog: {},
    shell: {},
    BrowserWindow: {},
}));

const authority = await import('../electron/src/path-authority');
const { registerDroppedVault } = await import('../electron/src/file-operations');

const grantFile = path.join(userData, 'granted-paths.json');

describe('path authority', () => {
    beforeEach(() => {
        authority.resetForTests();
        fs.rmSync(grantFile, { force: true });
    });

    it('denies everything until granted, vault files included', () => {
        expect(authority.isPathGranted('/etc/passwd')).toBe(false);
        expect(authority.isPathGranted('/home/user/vault.kdbx')).toBe(false);
        expect(authority.isPathGranted(42 as unknown as string)).toBe(false);
    });

    it('answers for the normalized path, however it is spelled', () => {
        authority.grantPath('/home/user/../user/key.bin');
        expect(authority.isPathGranted('/home/user/key.bin')).toBe(true);
    });

    it('persistent grants survive a new session', () => {
        authority.grantPathPersistent('/home/user/photo.jpg');
        authority.resetForTests();
        expect(authority.isPathGranted('/home/user/photo.jpg')).toBe(true);
    });

    it('session grants do not', () => {
        authority.grantPath('/home/user/session-only');
        authority.resetForTests();
        expect(authority.isPathGranted('/home/user/session-only')).toBe(false);
    });

    it('caps the persisted list, dropping the oldest', () => {
        for (let i = 0; i < 300; i++) authority.grantPathPersistent(`/keys/key-${i}`);
        authority.resetForTests();
        expect(authority.isPathGranted('/keys/key-299')).toBe(true);
        expect(authority.isPathGranted('/keys/key-10')).toBe(false);
    });

    // The list holds the locations of the user's key files
    it('writes the persisted list owner-only', function () {
        if (process.platform === 'win32') return;
        authority.grantPathPersistent('/home/user/vault.keyx');
        expect(fs.statSync(grantFile).mode & 0o777).toBe(0o600);
    });

    it('skips the rewrite when the path is already at the head', () => {
        authority.grantPathPersistent('/keys/current.keyx');
        const before = fs.statSync(grantFile).mtimeMs;
        fs.utimesSync(grantFile, new Date(0), new Date(0));
        authority.grantPathPersistent('/keys/current.keyx');
        expect(fs.statSync(grantFile).mtimeMs).toBeLessThan(before);
    });
});

// Reads and writes are separate capabilities: a key file the user picked at
// unlock must be readable, and save-to-file must still refuse to overwrite it
describe('write grant split', () => {
    beforeEach(() => {
        authority.resetForTests();
        fs.rmSync(grantFile, { force: true });
    });

    it('a plain grant allows reads only', () => {
        authority.grantPath('/home/user/unlock.keyx');
        expect(authority.isPathGranted('/home/user/unlock.keyx')).toBe(true);
        expect(authority.isPathGranted('/home/user/unlock.keyx', { write: true })).toBe(false);
    });

    it('a write grant allows both', () => {
        authority.grantPath('/home/user/vault.kdbx', { write: true });
        expect(authority.isPathGranted('/home/user/vault.kdbx')).toBe(true);
        expect(authority.isPathGranted('/home/user/vault.kdbx', { write: true })).toBe(true);
    });

    it('normalizes write grants like read grants', () => {
        authority.grantPath('/home/user/../user/vault.kdbx', { write: true });
        expect(authority.isPathGranted('/home/user/vault.kdbx', { write: true })).toBe(true);
    });

    it('round-trips the write bit through the persisted list', () => {
        authority.grantPathPersistent('/keys/unlock.keyx');
        authority.grantPathPersistent('/vaults/synced.kdbx', { write: true });
        authority.resetForTests();
        expect(authority.isPathGranted('/keys/unlock.keyx')).toBe(true);
        expect(authority.isPathGranted('/keys/unlock.keyx', { write: true })).toBe(false);
        expect(authority.isPathGranted('/vaults/synced.kdbx')).toBe(true);
        expect(authority.isPathGranted('/vaults/synced.kdbx', { write: true })).toBe(true);
    });

    it('reads a pre-split list of bare strings as read-only', () => {
        fs.writeFileSync(grantFile, JSON.stringify(['/keys/legacy.keyx']));
        expect(authority.isPathGranted('/keys/legacy.keyx')).toBe(true);
        expect(authority.isPathGranted('/keys/legacy.keyx', { write: true })).toBe(false);
    });

    it('leaves no temp file next to the persisted list', () => {
        authority.grantPathPersistent('/keys/a.keyx');
        const leftovers = fs.readdirSync(userData).filter(name => name.includes('.tmp-'));
        expect(leftovers).toEqual([]);
    });
});

describe('dropped vault registration', () => {
    beforeEach(() => authority.resetForTests());

    it('grants an absolute .kdbx path, writes included', () => {
        const granted = registerDroppedVault('/home/user/dropped.kdbx');
        expect(granted).toBe('/home/user/dropped.kdbx');
        expect(authority.isPathGranted('/home/user/dropped.kdbx')).toBe(true);
        expect(authority.isPathGranted('/home/user/dropped.kdbx', { write: true })).toBe(true);
    });

    // The grant behind this allows writes, so nothing but a vault file may
    // pass, and never a relative path
    it('refuses anything that is not an absolute vault path', () => {
        expect(registerDroppedVault('/home/user/.ssh/id_rsa')).toBe(null);
        expect(registerDroppedVault('vault.kdbx')).toBe(null);
        expect(registerDroppedVault('/etc/shadow/x.kdbx/../../shadow')).toBe(null);
        expect(authority.isPathGranted('/home/user/.ssh/id_rsa')).toBe(false);
    });
});

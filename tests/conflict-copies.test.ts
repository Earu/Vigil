import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
    isConflictCopyName,
    scanConflictCopies,
    nominateConflictCopy,
    isNominatedConflictCopy,
    resetNominationsForTests,
} from '../electron/src/conflict-copies';

// A sync client that cannot merge keeps both versions under a name of its
// own. These names nominate a file for the renderer to open and compare; a
// wrong nomination costs one key derivation, a missed one leaves the copy
// where it is, so the patterns lean towards matching.

describe('names sync clients give conflict copies', () => {
    const vault = 'vault.kdbx';
    const copies: Array<[string, string]> = [
        ['iCloud Drive', 'vault 2.kdbx'],
        ['iCloud Drive, later', 'vault 13.kdbx'],
        ['Google Drive', 'vault (1).kdbx'],
        ['Google Drive, conflicted copy', "vault (Ryan's conflicted copy 2026-09-05).kdbx"],
        ['Dropbox', "vault (Ryan's conflicted copy 2026-09-05).kdbx"],
        ['Dropbox, unnamed', 'vault (conflicted copy 2026-09-05).kdbx'],
        ['Nextcloud', 'vault (conflicted copy 2026-09-05 143012).kdbx'],
        ['OneDrive', 'vault-DESKTOP-4K2J9P1.kdbx'],
        ['OneDrive, hyphenated machine', 'vault-Ryans-MacBook.kdbx'],
        ['Syncthing', 'vault.sync-conflict-20260905-143012-ABCDEFG.kdbx'],
    ];
    for (const [client, name] of copies) {
        it(`${client}: ${name}`, () => {
            expect(isConflictCopyName(vault, name)).toBe(true);
        });
    }

    it('is case insensitive, as the filesystems these clients target mostly are', () => {
        expect(isConflictCopyName(vault, 'Vault 2.KDBX')).toBe(true);
    });

    it('anchors on the vault stem: another vault with a longer name is not a copy', () => {
        expect(isConflictCopyName(vault, 'vaults 2.kdbx')).toBe(false);
        expect(isConflictCopyName(vault, 'myvault 2.kdbx')).toBe(false);
        expect(isConflictCopyName('work.kdbx', 'vault 2.kdbx')).toBe(false);
    });

    it('never nominates the vault itself, its backups or other extensions', () => {
        expect(isConflictCopyName(vault, 'vault.kdbx')).toBe(false);
        expect(isConflictCopyName(vault, 'vault.kdbx.bak')).toBe(false);
        expect(isConflictCopyName(vault, 'vault 2.txt')).toBe(false);
        expect(isConflictCopyName(vault, '.vault.kdbx.tmp-0123abcd')).toBe(false);
        expect(isConflictCopyName(vault, 'vault.kdbx.tmp-0123abcd')).toBe(false);
    });

    it('treats regex metacharacters in the vault name as text', () => {
        expect(isConflictCopyName('my (main) vault.kdbx', 'my (main) vault 2.kdbx')).toBe(true);
        expect(isConflictCopyName('my (main) vault.kdbx', 'my Xmain) vault 2.kdbx')).toBe(false);
        expect(isConflictCopyName('a+b.kdbx', 'a+b (1).kdbx')).toBe(true);
        expect(isConflictCopyName('a+b.kdbx', 'aab (1).kdbx')).toBe(false);
    });
});

describe('scanning the vault directory', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-copies-'));
    afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
    const sha256 = (data: string) => crypto.createHash('sha256').update(data).digest('hex');

    it('returns each named copy with the hash of its bytes, and nothing else', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'scan-'));
        const vault = path.join(dir, 'vault.kdbx');
        fs.writeFileSync(vault, 'main');
        fs.writeFileSync(path.join(dir, 'vault 2.kdbx'), 'icloud');
        fs.writeFileSync(path.join(dir, 'vault-LAPTOP.kdbx'), 'onedrive');
        fs.writeFileSync(path.join(dir, 'other.kdbx'), 'unrelated');
        fs.writeFileSync(path.join(dir, 'vault.kdbx.bak'), 'backup');

        const found = await scanConflictCopies(vault);
        found.sort((a, b) => a.copyPath.localeCompare(b.copyPath));
        expect(found).toEqual([
            { copyPath: path.join(dir, 'vault 2.kdbx'), hash: sha256('icloud') },
            { copyPath: path.join(dir, 'vault-LAPTOP.kdbx'), hash: sha256('onedrive') },
        ]);
    });

    it('scans beside the file a symlinked vault points at', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'target-'));
        const target = path.join(dir, 'vault.kdbx');
        fs.writeFileSync(target, 'main');
        fs.writeFileSync(path.join(dir, 'vault (1).kdbx'), 'gdrive');
        const linkDir = fs.mkdtempSync(path.join(tmpRoot, 'link-'));
        const link = path.join(linkDir, 'vault.kdbx');
        fs.symlinkSync(target, link);

        const found = await scanConflictCopies(link);
        expect(found).toEqual([{ copyPath: path.join(dir, 'vault (1).kdbx'), hash: sha256('gdrive') }]);
    });

    it('yields nothing for a directory that cannot be listed', async () => {
        expect(await scanConflictCopies(path.join(tmpRoot, 'missing', 'vault.kdbx'))).toEqual([]);
    });

    it('skips a candidate that vanishes between the listing and the read', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'gone-'));
        const vault = path.join(dir, 'vault.kdbx');
        fs.writeFileSync(vault, 'main');
        const found = await scanConflictCopies(vault, {
            readdir: async () => ['vault.kdbx', 'vault 2.kdbx', 'vault 3.kdbx'],
            hash: async (file) => {
                if (file.endsWith('vault 2.kdbx')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                return 'h3';
            },
        });
        expect(found).toEqual([{ copyPath: path.join(dir, 'vault 3.kdbx'), hash: 'h3' }]);
    });
});

describe('nominations', () => {
    it('remember a copy by resolved path and nothing else', () => {
        resetNominationsForTests();
        nominateConflictCopy('/vaults/./vault 2.kdbx');
        expect(isNominatedConflictCopy('/vaults/vault 2.kdbx')).toBe(true);
        expect(isNominatedConflictCopy('/vaults/vault 3.kdbx')).toBe(false);
        expect(isNominatedConflictCopy('/keys/vault.keyx')).toBe(false);
        expect(isNominatedConflictCopy(undefined)).toBe(false);
        expect(isNominatedConflictCopy(42)).toBe(false);
    });
});

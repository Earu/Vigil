import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Sync clients that cannot merge two versions of a file keep both, under a
// name of their own: iCloud Drive writes "vault 2.kdbx", Dropbox and Nextcloud
// "vault (conflicted copy 2026-09-05).kdbx", Google Drive "vault (1).kdbx" or
// a conflicted-copy name, OneDrive "vault-MACHINE.kdbx", Syncthing
// "vault.sync-conflict-20260905-123456-ABCDEFG.kdbx". The copy then diverges
// quietly beside the vault the user actually opens.
//
// The name is only a nomination. Nothing here decides that a file is a copy
// of the open vault: the renderer opens the candidate with the vault's own
// credentials and compares root group UUIDs before merging anything, and the
// user is asked before the copy is moved to the trash. A wrongly named file
// therefore costs one key derivation and nothing else. No electron import,
// so the watcher (electron/src/vault-watcher.ts) and the tests can use this
// directly.

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One expression per client family, all anchored on the vault's own stem and
// extension. Case-insensitive: the filesystems these clients target mostly
// are, and the check that matters happens later anyway
export function conflictCopyPatterns(vaultBasename: string): RegExp[] {
    const ext = path.extname(vaultBasename);
    const stem = escape(vaultBasename.slice(0, vaultBasename.length - ext.length));
    const suffix = escape(ext);
    return [
        // iCloud Drive: "vault 2.kdbx"
        new RegExp(`^${stem} \\d+${suffix}$`, 'i'),
        // Google Drive: "vault (1).kdbx"
        new RegExp(`^${stem} \\(\\d+\\)${suffix}$`, 'i'),
        // Dropbox, Nextcloud, Google Drive: "vault (Ryan's conflicted copy 2026-09-05).kdbx"
        new RegExp(`^${stem} \\(.*conflicted copy.*\\)${suffix}$`, 'i'),
        // OneDrive: "vault-DESKTOP-ABC123.kdbx"
        new RegExp(`^${stem}-[^./\\\\]+${suffix}$`, 'i'),
        // Syncthing: "vault.sync-conflict-20260905-123456-ABCDEFG.kdbx"
        new RegExp(`^${stem}\\.sync-conflict-\\d{8}-\\d{6}-[A-Z0-9]+${suffix}$`, 'i'),
    ];
}

export function isConflictCopyName(vaultBasename: string, candidate: string): boolean {
    if (candidate === vaultBasename) return false;
    return conflictCopyPatterns(vaultBasename).some(pattern => pattern.test(candidate));
}

// Where the vault's bytes actually are: a vault reached through a symlink is
// written at the link's target (file-operations resolveWriteTarget), and its
// copies land beside the target
export function resolveVaultFile(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

export function hashFile(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath)
        .then(data => crypto.createHash('sha256').update(data).digest('hex'));
}

export interface ConflictCopy {
    copyPath: string;
    hash: string;
}

// Every file beside the vault whose name says a sync client made it from
// this vault. Unreadable candidates are skipped; a directory that cannot be
// listed yields nothing
export async function scanConflictCopies(
    vaultPath: string,
    deps: { readdir?: (dir: string) => Promise<string[]>; hash?: (file: string) => Promise<string> } = {}
): Promise<ConflictCopy[]> {
    const target = resolveVaultFile(vaultPath);
    const dir = path.dirname(target);
    const name = path.basename(target);
    let names: string[];
    try {
        names = await (deps.readdir ?? (d => fs.promises.readdir(d)))(dir);
    } catch {
        return [];
    }
    const found: ConflictCopy[] = [];
    for (const candidate of names) {
        if (!isConflictCopyName(name, candidate)) continue;
        const copyPath = path.join(dir, candidate);
        try {
            found.push({ copyPath, hash: await (deps.hash ?? hashFile)(copyPath) });
        } catch { /* gone between the listing and the read */ }
    }
    return found;
}

// The copies the main process itself has named beside an open vault. The
// renderer may ask for one of these to be trashed and for nothing else: the
// nomination is what makes "delete this file" a request about a conflict
// copy rather than about an arbitrary granted path (a key file is granted
// too, and must never be deletable from the renderer)
const nominated = new Set<string>();

export function nominateConflictCopy(copyPath: string): void {
    nominated.add(path.resolve(copyPath));
}

export function isNominatedConflictCopy(copyPath: unknown): boolean {
    return typeof copyPath === 'string' && nominated.has(path.resolve(copyPath));
}

export function resetNominationsForTests(): void {
    nominated.clear();
}

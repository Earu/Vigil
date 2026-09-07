import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { materialize } from './cloud-files';

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
        // OneDrive: "vault-DESKTOP-ABC123.kdbx", the suffix being the machine
        // name. Held to what Windows lets one be (1 to 15 characters, letters,
        // digits and inner hyphens, at least one letter) rather than the
        // anything-without-a-slash this used to take, which claimed every
        // sibling named after the vault: vault-archive-2024.kdbx and its like
        // were read, opened with the vault's credentials and merged in
        // whenever they shared its root UUID, which a vault forked by copying
        // this one does. A machine name and a short word are the same shape,
        // so vault-work.kdbx is still claimed; what this drops is everything
        // longer, punctuated or spaced
        new RegExp(`^${stem}-(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?${suffix}$`, 'i'),
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

// Whether the folder around the vault can be listed at all. macOS grants a
// file the user picked in the open dialog without granting the folder it
// sits in: iCloud Drive, Desktop, Documents and Downloads each need their own
// Files and Folders consent, so the vault opens while the copies beside it
// stay invisible, to the scan below and to the watcher alike. The folder can
// be granted the same way the file was, by the user picking it in an open
// dialog (window.ts requestVaultFolderAccess), and macOS keeps that grant
export type FolderAccess =
    | { listable: true }
    | { listable: false; reason: 'permission' | 'other'; code: string };

export async function probeVaultFolder(
    vaultPath: string,
    deps: { readdir?: (dir: string) => Promise<string[]>; platform?: NodeJS.Platform } = {}
): Promise<FolderAccess> {
    const dir = path.dirname(resolveVaultFile(vaultPath));
    try {
        await (deps.readdir ?? (d => fs.promises.readdir(d)))(dir);
        return { listable: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        const platform = deps.platform ?? process.platform;
        const reason = platform === 'darwin' && code === 'EPERM' ? 'permission' : 'other';
        return { listable: false, reason, code };
    }
}

// The most a vault, or a file named like a copy of one, may be before this
// refuses to read it whole.
//
// A vault normally sits in a folder a sync client writes to, which means the
// set of things that can put a file next to it is larger than the set of
// things that can run code here: a shared folder, or a sync account someone
// else got into. Every path that follows a vault reads the file entirely
// into the main process to hash or open it, and the watcher does that again
// on every change, with a countdown per file name so several can be in
// flight at once. Nothing on the way there looked at how big the file was.
//
// Far above any real vault (kdbx attachments are keys and recovery kits),
// and low enough that a file planted to be read cannot take the process with
// it. Not derived from the vault's own size: a legitimate copy can be
// larger, and a bound that moves with the thing it is bounding is one an
// attacker with write access to the folder also moves
export const MAX_VAULT_BYTES = 512 * 1024 * 1024;

export class VaultTooLargeError extends Error {
    constructor(readonly size: number) {
        super(`The file is ${Math.round(size / 1024 / 1024)} MB, larger than a vault this app will read`);
        this.name = 'VaultTooLargeError';
    }
}

// One handle for the size and the bytes, so what is measured is what is then
// read rather than whatever the path names at each of two moments
export async function readBoundedFile(filePath: string, maxBytes = MAX_VAULT_BYTES): Promise<Buffer> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const { size } = await handle.stat();
        if (size > maxBytes) throw new VaultTooLargeError(size);
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

export function hashFile(filePath: string): Promise<string> {
    return readBoundedFile(filePath)
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
    deps: {
        readdir?: (dir: string) => Promise<string[]>;
        hash?: (file: string) => Promise<string>;
        download?: (file: string) => Promise<unknown>;
    } = {}
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
        // An evicted iCloud copy (".vault 2.kdbx.icloud") is asked back; the
        // watcher reports it under its real name once the bytes land
        const evicted = /^\.(.+)\.icloud$/.exec(candidate);
        if (evicted && isConflictCopyName(name, evicted[1])) {
            void (deps.download ?? materialize)(path.join(dir, evicted[1]));
            continue;
        }
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

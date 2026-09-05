import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

// iCloud Drive with "Optimize Mac Storage" evicts files it considers cold:
// the bytes leave the disk and the directory holds ".vault.kdbx.icloud", a
// small plist, where the vault was. To every POSIX call the vault is gone,
// so an evicted last-opened vault vanished from the start screen. brctl
// download asks the daemon for the bytes back and the real name reappears
// when they land.
//
// Only the macOS daemon evicts this way. iCloud for Windows and OneDrive use
// the Cloud Files API, Dropbox, Google Drive and OneDrive on macOS a File
// Provider root (~/Library/CloudStorage), and an rclone mount serves any
// remote over FUSE: in all of these the file keeps its name while its bytes
// are elsewhere and the read fetches them. They need no help here, only a
// read failure that says what went wrong.

export function icloudPlaceholder(filePath: string): string {
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.icloud`);
}

export interface CloudDeps {
    platform?: NodeJS.Platform;
    exists?: (filePath: string) => Promise<boolean>;
    download?: (filePath: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    homedir?: string;
    // Contents of /proc/self/mounts on Linux
    mounts?: () => string;
}

const POLL_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const realExists = (filePath: string) => fs.promises.access(filePath).then(() => true, () => false);
const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const realMounts = () => { try { return fs.readFileSync('/proc/self/mounts', 'utf8'); } catch { return ''; } };
const brctlDownload = (filePath: string) => new Promise<void>((resolve, reject) => {
    execFile('brctl', ['download', filePath], { timeout: 10_000 }, error => error ? reject(error) : resolve());
});

let defaults: CloudDeps = {};

// Tests run on Linux with no brctl; they swap the platform and the download
export function setCloudDepsForTests(deps: CloudDeps): void {
    defaults = deps;
}

function resolveDeps(deps: CloudDeps): Required<CloudDeps> {
    const merged = { ...defaults, ...deps };
    return {
        platform: merged.platform ?? process.platform,
        exists: merged.exists ?? realExists,
        download: merged.download ?? brctlDownload,
        sleep: merged.sleep ?? realSleep,
        timeoutMs: merged.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
        env: merged.env ?? process.env,
        homedir: merged.homedir ?? os.homedir(),
        mounts: merged.mounts ?? realMounts,
    };
}

// True when iCloud Drive holds the file's bytes and the disk only its placeholder
export async function isEvicted(filePath: string, deps: CloudDeps = {}): Promise<boolean> {
    const d = resolveDeps(deps);
    if (d.platform !== 'darwin') return false;
    if (await d.exists(filePath)) return false;
    return d.exists(icloudPlaceholder(filePath));
}

export type MaterializeResult = { ok: true } | { ok: false; error: string };

// Makes an evicted file present again, waiting for the download. A file that
// is present, or was never evicted, returns at once
export async function materialize(filePath: string, deps: CloudDeps = {}): Promise<MaterializeResult> {
    const d = resolveDeps(deps);
    if (!await isEvicted(filePath, d)) return { ok: true };

    const name = path.basename(filePath);
    try {
        await d.download(filePath);
    } catch (error) {
        console.error('iCloud download request failed:', error);
        return { ok: false, error: `${name} is stored in iCloud Drive and could not be downloaded` };
    }

    const deadline = Date.now() + d.timeoutMs;
    while (Date.now() < deadline) {
        if (await d.exists(filePath)) return { ok: true };
        await d.sleep(POLL_MS);
    }
    return { ok: false, error: `${name} is stored in iCloud Drive and has not finished downloading. Try again in a moment` };
}

// The client whose root the path lies under, for error messages; null for a
// path that is plain local storage as far as this can tell
export function cloudClientFor(filePath: string, deps: CloudDeps = {}): string | null {
    const d = resolveDeps(deps);
    // Paths are in the platform's own syntax, which the tests cross
    const p = d.platform === 'win32' ? path.win32 : path.posix;
    const under = (root: string | undefined): boolean => {
        if (!root) return false;
        const rel = p.relative(root, filePath);
        return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
    };

    if (d.platform === 'darwin') {
        if (under(p.join(d.homedir, 'Library', 'Mobile Documents'))) return 'iCloud Drive';
        const storage = p.join(d.homedir, 'Library', 'CloudStorage');
        if (under(storage)) {
            // Provider folders are named "Dropbox", "GoogleDrive-<account>",
            // "OneDrive-Personal"
            const folder = p.relative(storage, filePath).split(p.sep)[0].split('-')[0];
            return folder === 'GoogleDrive' ? 'Google Drive' : folder || 'your sync client';
        }
        return null;
    }

    if (d.platform === 'win32') {
        for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
            if (under(d.env[key])) return 'OneDrive';
        }
        if (under(p.join(d.homedir, 'iCloudDrive'))) return 'iCloud Drive';
        return null;
    }

    if (d.platform === 'linux') {
        // "icloud: /home/ryan/iCloudDrive fuse.rclone rw,... 0 0"; the mount
        // point has spaces escaped as \040
        for (const line of d.mounts().split('\n')) {
            const [, mountPoint, type] = line.split(' ');
            if (type !== 'fuse.rclone' || !mountPoint) continue;
            if (under(mountPoint.replace(/\\040/g, ' '))) return 'rclone';
        }
        return null;
    }

    return null;
}

const LOCAL_READ_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR']);

// A read that fails under a cloud root with an error the local filesystem
// would not produce is a download that did not happen (offline, provider
// stopped). Say so instead of "Failed to read file"
export function describeReadFailure(filePath: string, error: unknown, deps: CloudDeps = {}): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && LOCAL_READ_ERRORS.has(code)) return 'Failed to read file';
    const client = cloudClientFor(filePath, deps);
    if (!client) return 'Failed to read file';
    const p = resolveDeps(deps).platform === 'win32' ? path.win32 : path.posix;
    return `${p.basename(filePath)} is stored online by ${client} and could not be downloaded`;
}

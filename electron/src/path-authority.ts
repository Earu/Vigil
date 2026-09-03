import { app } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Which filesystem paths the renderer may ask the main process to touch.
// read-file, stat-file and save-to-file take path strings over IPC, and
// every one of them must trace back to something the user pointed the app
// at: a main-process dialog, a file-manager open, a real dropped file, or
// the last-database record. The renderer can never mint a grant.
//
// Reads and writes are separate capabilities. Every vault-open route grants
// { write: true } because save-to-file will later overwrite that path; key
// files and attachment destinations are granted read-only, so a compromised
// renderer cannot ask save-to-file to replace a key file with vault bytes.
//
// Key files are granted persistently (capped, newest first): the renderer
// remembers key file paths across sessions and reads them at unlock, long
// after the dialog that chose them. Vault paths need no persistence, since
// every open route re-grants them each session.

const granted = new Set<string>();
const writeGranted = new Set<string>();

interface PersistedGrant { path: string, write: boolean }

const PERSIST_CAP = 256;
const persistFile = () => path.join(app.getPath('userData'), 'granted-paths.json');
let persisted: PersistedGrant[] | null = null;

export interface GrantOptions { write?: boolean }

// Case folded on Windows: the same file arrives spelled differently from
// argv, dialogs and the last-database record on its case-insensitive
// filesystems. Elsewhere case stays significant
const normalize = (filePath: string): string => {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function loadPersisted(): PersistedGrant[] {
    if (persisted === null) {
        try {
            const parsed = JSON.parse(fs.readFileSync(persistFile(), 'utf8'));
            // Bare strings are the pre-split format: read-only grants
            persisted = Array.isArray(parsed)
                ? parsed.flatMap((entry): PersistedGrant[] => {
                    if (typeof entry === 'string') return [{ path: entry, write: false }];
                    if (entry && typeof entry.path === 'string') return [{ path: entry.path, write: entry.write === true }];
                    return [];
                })
                : [];
        } catch {
            persisted = [];
        }
    }
    return persisted;
}

// Temp in the same dir then rename: a crash mid-write must not truncate the
// list. Created exclusively ('wx') under a random name so nothing pre-planted
// at a guessable path (a symlink) can capture the write; the mode only
// applies on create and the umask masks it, hence the chmod on the temp file
// that survives the rename
function writeSidecarSync(file: string, data: string): void {
    const tmp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* never created */ }
        throw error;
    }
}

export function grantPath(filePath: string, options?: GrantOptions): void {
    const normalized = normalize(filePath);
    granted.add(normalized);
    if (options?.write) writeGranted.add(normalized);
}

export function grantPathPersistent(filePath: string, options?: GrantOptions): void {
    const normalized = normalize(filePath);
    const write = options?.write === true;
    granted.add(normalized);
    if (write) writeGranted.add(normalized);
    const list = loadPersisted();
    if (list[0]?.path === normalized && list[0].write === write) return;
    persisted = [{ path: normalized, write }, ...list.filter(g => g.path !== normalized)].slice(0, PERSIST_CAP);
    try {
        // The list holds the locations of the user's key files, so it gets
        // the same owner-only mode the vault writes enforce
        fs.mkdirSync(path.dirname(persistFile()), { recursive: true });
        writeSidecarSync(persistFile(), JSON.stringify(persisted));
    } catch { /* the grant still holds for this session */ }
}

export function isPathGranted(filePath: unknown, options?: GrantOptions): boolean {
    if (typeof filePath !== 'string') return false;
    const normalized = normalize(filePath);
    if (options?.write) {
        return writeGranted.has(normalized) || loadPersisted().some(g => g.path === normalized && g.write);
    }
    return granted.has(normalized) || loadPersisted().some(g => g.path === normalized);
}

// Tests re-run setup against a fresh temp userData
export function resetForTests(): void {
    granted.clear();
    writeGranted.clear();
    persisted = null;
}

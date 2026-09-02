import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// Which filesystem paths the renderer may ask the main process to touch.
// read-file, stat-file and save-to-file take path strings over IPC, and
// every one of them must trace back to something the user pointed the app
// at: a main-process dialog, a file-manager open, a real dropped file, or
// the last-database record. The renderer can never mint a grant.
//
// Key files are granted persistently (capped, newest first): the renderer
// remembers key file paths across sessions and reads them at unlock, long
// after the dialog that chose them. Vault paths need no persistence, since
// every open route re-grants them each session.

const granted = new Set<string>();

const PERSIST_CAP = 256;
const persistFile = () => path.join(app.getPath('userData'), 'granted-paths.json');
let persisted: string[] | null = null;

// Case folded on Windows: the same file arrives spelled differently from
// argv, dialogs and the last-database record on its case-insensitive
// filesystems. Elsewhere case stays significant
const normalize = (filePath: string): string => {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function loadPersisted(): string[] {
    if (persisted === null) {
        try {
            const parsed = JSON.parse(fs.readFileSync(persistFile(), 'utf8'));
            persisted = Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
        } catch {
            persisted = [];
        }
    }
    return persisted;
}

export function grantPath(filePath: string): void {
    granted.add(normalize(filePath));
}

export function grantPathPersistent(filePath: string): void {
    const normalized = normalize(filePath);
    granted.add(normalized);
    const list = loadPersisted();
    if (list[0] === normalized) return;
    persisted = [normalized, ...list.filter(p => p !== normalized)].slice(0, PERSIST_CAP);
    try {
        // The list holds the locations of the user's key files, so it gets
        // the same owner-only mode the vault writes enforce. writeFileSync's
        // mode only applies on create, hence the chmod for an existing file
        fs.mkdirSync(path.dirname(persistFile()), { recursive: true });
        fs.writeFileSync(persistFile(), JSON.stringify(persisted), { mode: 0o600 });
        if (process.platform !== 'win32') fs.chmodSync(persistFile(), 0o600);
    } catch { /* the grant still holds for this session */ }
}

export function isPathGranted(filePath: unknown): boolean {
    if (typeof filePath !== 'string') return false;
    const normalized = normalize(filePath);
    return granted.has(normalized) || loadPersisted().includes(normalized);
}

// Tests re-run setup against a fresh temp userData
export function resetForTests(): void {
    granted.clear();
    persisted = null;
}

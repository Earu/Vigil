import * as kdbxweb from 'kdbxweb';

// Simulated electron IPC surface plus a byte sink standing in for the file
// on disk. Tests drive KeepassDatabaseService exactly like the renderer does.
export interface MockDisk {
    bytes: Buffer | null;
    mtime: number;
}

export interface MockEnv {
    disk: MockDisk;
    toasts: string[];
    confirm: { answer: boolean; calls: number };
    // Backup request the last save handed to the main process
    lastBackup: any;
}

export function installMockWindow(): MockEnv {
    const env: MockEnv = {
        disk: { bytes: null, mtime: 100 },
        toasts: [],
        confirm: { answer: true, calls: 0 },
        lastBackup: undefined,
    };

    (globalThis as any).window = {
        electron: {
            saveToFile: async (_path: string, data: Uint8Array, backup?: unknown) => {
                env.lastBackup = backup;
                env.disk.bytes = Buffer.from(data);
                env.disk.mtime++;
                return { success: true };
            },
            saveFile: async (data: Uint8Array) => {
                env.disk.bytes = Buffer.from(data);
                env.disk.mtime++;
                return { success: true, filePath: '/fake.kdbx' };
            },
            statFile: async () => ({ success: true, mtimeMs: env.disk.mtime, size: env.disk.bytes?.length ?? 0 }),
            readFile: async () => ({ success: true, data: new Uint8Array(env.disk.bytes!) }),
        },
        showToast: (t: { message: string }) => env.toasts.push(t.message),
        confirm: (_msg: string) => {
            env.confirm.calls++;
            return env.confirm.answer;
        },
    };

    return env;
}

// The save path asks about unmergeable external changes through a resolver
// App registers (window.confirm is gone from it); tests answer with
// env.confirm so their dialog-driving surface stays the same
export const wireConflictResolver = (
    Svc: { conflictResolver?: (message: string) => Promise<boolean> },
    env: MockEnv
): void => {
    Svc.conflictResolver = async () => {
        env.confirm.calls++;
        return env.confirm.answer;
    };
};

export const cred = () => new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));

// Copy a string into a fresh, exactly-sized ArrayBuffer (Buffer.from(str).buffer
// is the shared pool and must never be used directly)
export const ab = (s: string): ArrayBuffer => Uint8Array.from(Buffer.from(s)).buffer;

export const attachmentBytes = (kdbxEntry: kdbxweb.KdbxEntry, name: string): Buffer | null => {
    const val = kdbxEntry.binaries.get(name);
    if (!val) return null;
    const v = (val as kdbxweb.KdbxBinaryWithHash).value ?? val;
    return v instanceof kdbxweb.ProtectedValue
        ? Buffer.from(v.getBinary())
        : Buffer.from(new Uint8Array(v as ArrayBuffer));
};

export const loadSaved = (env: MockEnv) =>
    kdbxweb.Kdbx.load(new Uint8Array(env.disk.bytes!).buffer.slice(0) as ArrayBuffer, cred());

export const allTitles = (db: kdbxweb.Kdbx): string[] => {
    const out: string[] = [];
    const walk = (g: kdbxweb.KdbxGroup) => {
        g.entries.forEach(e => out.push(e.fields.get('Title') as string));
        g.groups.forEach(walk);
    };
    walk(db.getDefaultGroup());
    return out;
};

export const tick = () => new Promise(r => setTimeout(r, 20));

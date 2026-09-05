import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import crypto from 'crypto';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv, wireConflictResolver } from './helpers';

// The main-process watcher reports "the file is now these bytes" while the
// vault is open; reloadExternalChanges merges that version in the way a save
// would. What matters: a real change lands, Vigil's own writes and mere
// touches do nothing, a version that cannot be merged leaves the save path's
// conflict handling intact, and the version merged in is still backed up by
// the save that overwrites it.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
wireConflictResolver(Svc, env);

const electron = () => (globalThis as any).window.electron;
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
// What the watcher would send for the file as it is on disk right now
const diskHint = () => ({ hash: sha256(env.disk.bytes!), mtimeMs: env.disk.mtime });

async function writeVault(): Promise<void> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 500;
}

// Opens the vault the way PasswordForm does: load, then setPath with the
// bytes, and let the baseline settle
async function openVault(): Promise<kdbxweb.Kdbx> {
    const db = await loadSaved(env);
    Svc.setPath('/fake.kdbx', new Uint8Array(env.disk.bytes!));
    await tick();
    return db;
}

// Another machine adds an entry and the sync client lands the file
async function remoteAdds(title = 'RemoteEntry'): Promise<void> {
    const remote = await loadSaved(env);
    remote.createEntry(remote.getDefaultGroup()).fields.set('Title', title);
    env.disk.bytes = Buffer.from(await remote.save());
    env.disk.mtime += 50;
}

async function localEditAndSave(db: kdbxweb.Kdbx, notes: string): Promise<void> {
    const model = Svc.convertKdbxToDatabase(db);
    const [edited] = Svc.saveEntry(model, { ...model.root.entries[0], notes }, model.root, false);
    await Svc.saveDatabase(edited, db);
}

let reads: number;
const baseReadFile = electron().readFile;

beforeEach(() => {
    env.toasts.length = 0;
    env.confirm.calls = 0;
    env.confirm.answer = true;
    env.lastBackup = undefined;
    reads = 0;
    electron().readFile = async (...args: unknown[]) => {
        reads++;
        return baseReadFile(...args);
    };
    Svc.setPath(undefined);
});

describe('a change landing while the vault is open', () => {
    it('is merged into the open vault and reported', async () => {
        await writeVault();
        const db = await openVault();
        await remoteAdds();

        const result = await Svc.reloadExternalChanges(db, diskHint());

        expect(result).toBe('merged');
        expect(allTitles(db)).toContain('RemoteEntry');
        expect(allTitles(db)).toContain('Kept');
        expect(env.toasts.some(t => t.includes('external changes were merged'))).toBe(true);
    });

    it('shows up in the model the caller rebuilds', async () => {
        await writeVault();
        const db = await openVault();
        await remoteAdds();
        await Svc.reloadExternalChanges(db, diskHint());

        const model = Svc.convertKdbxToDatabase(db);
        expect(model.root.entries.map(e => e.title)).toContain('RemoteEntry');
    });

    it('moves the baseline, so the next save does not merge the same version twice', async () => {
        await writeVault();
        const db = await openVault();
        await remoteAdds();
        await Svc.reloadExternalChanges(db, diskHint());
        env.toasts.length = 0;

        await localEditAndSave(db, 'edited here');

        expect(env.toasts.some(t => t.includes('external changes were merged'))).toBe(false);
        expect(allTitles(await loadSaved(env))).toEqual(expect.arrayContaining(['Kept', 'RemoteEntry']));
    });

    it('is still backed up by the save that overwrites it', async () => {
        await writeVault();
        const db = await openVault();
        await remoteAdds();
        await Svc.reloadExternalChanges(db, diskHint());

        await localEditAndSave(db, 'first save after the merge');
        expect(env.lastBackup.replacingExternalChanges).toBe(true);

        await localEditAndSave(db, 'second save');
        expect(env.lastBackup.replacingExternalChanges).toBe(false);
    });
});

describe('an event that carries nothing new', () => {
    it('for the bytes already known reads nothing', async () => {
        await writeVault();
        const db = await openVault();
        reads = 0;

        // A sync client touched the file without changing it
        env.disk.mtime += 10;
        const result = await Svc.reloadExternalChanges(db, diskHint());

        expect(result).toBe('unchanged');
        expect(reads).toBe(0);
        expect(env.toasts).toEqual([]);
    });

    it('for Vigil\'s own write, reported before the save finished, waits for the save', async () => {
        await writeVault();
        const db = await openVault();

        // Hold the write so the save is in flight when the event arrives
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const realSave = electron().saveToFile;
        let saveDone = false;
        electron().saveToFile = async (...args: unknown[]) => {
            await held;
            const result = await realSave(...args);
            saveDone = true;
            return result;
        };
        try {
            const save = localEditAndSave(db, 'in flight');
            await tick();
            const hintBeforeWrite = diskHint();
            let doneAt: boolean | null = null;
            const reload = Svc.reloadExternalChanges(db, hintBeforeWrite).then(result => {
                doneAt = saveDone;
                return result;
            });
            await tick();
            expect(doneAt).toBeNull();
            release();
            await save;
            expect(await reload).toBe('unchanged');
            expect(doneAt).toBe(true);
        } finally {
            electron().saveToFile = realSave;
        }
        expect(env.toasts.some(t => t.includes('external changes were merged'))).toBe(false);
    });

    it('with a stale hash but unchanged bytes on disk updates only the mtime', async () => {
        await writeVault();
        const db = await openVault();

        const result = await Svc.reloadExternalChanges(db, { hash: 'not-what-is-on-disk', mtimeMs: env.disk.mtime + 5 });

        expect(result).toBe('unchanged');
        expect(reads).toBe(1);
    });
});

describe('a version that cannot be merged', () => {
    it('is reported as failed and left for the save path to ask about', async () => {
        await writeVault();
        const db = await openVault();

        // Another machine changed the master password
        const remote = await loadSaved(env);
        await remote.credentials.setPassword(kdbxweb.ProtectedValue.fromString('rotated'));
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime += 50;

        const result = await Svc.reloadExternalChanges(db, diskHint());
        expect(result).toBe('failed');
        expect(allTitles(db)).toEqual(['Kept']);

        // The baseline still names the version Vigil last knew, so the save
        // notices the difference and goes through the conflict resolver
        env.confirm.answer = false;
        await expect(localEditAndSave(db, 'local')).rejects.toThrow('SAVE_CANCELLED_CONFLICT');
        expect(env.confirm.calls).toBe(1);
    });
});

describe('a lock while the reload is in progress', () => {
    it('discards the result and touches nothing', async () => {
        await writeVault();
        const db = await openVault();
        await remoteAdds();

        // Hold the read so the lock can land in the middle
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        electron().readFile = async (...args: unknown[]) => {
            await held;
            return baseReadFile(...args);
        };

        const reload = Svc.reloadExternalChanges(db, diskHint());
        await tick();
        Svc.setPath(undefined);
        release();

        expect(await reload).toBe('unchanged');
        expect(allTitles(db)).toEqual(['Kept']);
        expect(env.toasts).toEqual([]);
    });
});

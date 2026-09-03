import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, allTitles, tick, MockEnv, wireConflictResolver } from './helpers';

// External-change detection rests on a baseline (mtime + content hash) that
// setPath fills in with two independent best-effort fetches. Either fetch can
// fail transiently (a sync client holding the file, a slow mount) and nothing
// retries, so the save path has to cope with a half-filled baseline: a
// missing mtime must not silently disable the conflict check, and a missing
// hash must not turn a bare timestamp touch into a phantom merge.

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
wireConflictResolver(Svc, env);

const electron = () => (globalThis as any).window.electron;

async function writeVault(): Promise<void> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    env.disk.bytes = Buffer.from(await db0.save());
    env.disk.mtime = 500;
}

// Another machine adds an entry and writes the file
async function remoteAdds(): Promise<void> {
    const remote = await loadSaved(env);
    remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'RemoteEntry');
    env.disk.bytes = Buffer.from(await remote.save());
    env.disk.mtime += 50;
}

async function localEditAndSave(db: kdbxweb.Kdbx, notes: string): Promise<void> {
    const model = Svc.convertKdbxToDatabase(db);
    const [edited] = Svc.saveEntry(model, { ...model.root.entries[0], notes }, model.root, false);
    await Svc.saveDatabase(edited, db);
}

beforeEach(() => {
    env.toasts.length = 0;
    env.confirm.calls = 0;
    env.confirm.answer = true;
});

describe('a baseline missing its mtime (the opening stat failed)', () => {
    it('still merges instead of overwriting another machine\'s changes', async () => {
        await writeVault();
        const db = await loadSaved(env);

        const statFile = electron().statFile;
        electron().statFile = async () => ({ success: false, error: 'EIO' });
        Svc.setPath('/fake.kdbx');
        await tick();
        // The failure was transient; later stats work
        electron().statFile = statFile;

        await remoteAdds();
        await localEditAndSave(db, 'local');

        const onDisk = await loadSaved(env);
        expect(allTitles(onDisk).sort()).toEqual(['Kept', 'RemoteEntry']);
        const kept = onDisk.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Kept')!;
        expect(kept.fields.get('Notes')).toBe('local');
    });
});

describe('the content baseline (from the bytes the vault was opened with)', () => {
    it('does not merge or notify on a timestamp touch even when the file cannot be re-read', async () => {
        await writeVault();
        const db = await loadSaved(env);

        // The open path hands setPath the bytes it just loaded, so the hash
        // baseline cannot be lost to a failed or racing second read
        const readFile = electron().readFile;
        electron().readFile = async () => ({ success: false, error: 'EIO' });
        Svc.setPath('/fake.kdbx', new Uint8Array(env.disk.bytes!));
        await tick();
        electron().readFile = readFile;

        // A sync client or backup tool touches the file without changing it
        env.disk.mtime += 10;
        await localEditAndSave(db, 'local');

        expect(env.toasts).not.toContain('The database changed on disk; external changes were merged');
        expect(env.confirm.calls).toBe(0);
    });
});

describe('a complete baseline (control)', () => {
    it('merges external changes on save', async () => {
        await writeVault();
        const db = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();

        await remoteAdds();
        await localEditAndSave(db, 'local');

        expect(allTitles(await loadSaved(env)).sort()).toEqual(['Kept', 'RemoteEntry']);
    });

    it('stays quiet on a bare timestamp touch', async () => {
        await writeVault();
        const db = await loadSaved(env);
        Svc.setPath('/fake.kdbx');
        await tick();

        env.disk.mtime += 10;
        await localEditAndSave(db, 'local');

        expect(env.toasts).not.toContain('The database changed on disk; external changes were merged');
        expect(env.confirm.calls).toBe(0);
    });
});

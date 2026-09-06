import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, MockEnv } from './helpers';

// A settings change that never reached the file must not be announced as
// applied. The key file is the one that also has to wait: setting it before
// the save left the vault holding a composite key the file did not have, and
// the remembered path naming a key file it did not want, so the next unlock
// failed on a database the user had been told was fine.
const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const KEYFILE = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

async function openVault(): Promise<kdbxweb.Kdbx> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    const bytes = new Uint8Array(await db0.save());
    env.disk.bytes = Buffer.from(bytes);
    const db = await kdbxweb.Kdbx.load(bytes.slice().buffer, cred());
    Svc.setPath('/vault.kdbx', bytes);
    await new Promise((r) => setTimeout(r, 0));
    return db;
}

const withKeyFile = async () => {
    const c = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));
    await c.setKeyFile(KEYFILE);
    return c;
};

beforeEach(() => { env.toasts.length = 0; });

describe('a key file change', () => {
    it('is applied by the save, so the file and the vault agree', async () => {
        const db = await openVault();

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { keyFile: KEYFILE });

        // The written file wants the key file, and so does the open vault
        const onDisk = Uint8Array.from(env.disk.bytes!).buffer;
        await expect(kdbxweb.Kdbx.load(onDisk, cred())).rejects.toThrow();
        await expect(kdbxweb.Kdbx.load(onDisk, await withKeyFile())).resolves.toBeTruthy();
        expect(db.credentials.keyFileHash).toBeTruthy();
    });

    it('leaves the vault without one when the write fails', async () => {
        const db = await openVault();
        const electron = (globalThis as any).window.electron;
        const realSave = electron.saveToFile;
        electron.saveToFile = async () => ({ success: false, error: 'locked' });
        try {
            await expect(
                Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { keyFile: KEYFILE })
            ).rejects.toThrow();
        } finally {
            electron.saveToFile = realSave;
        }

        // No half-applied credential: the vault still opens the file as before
        expect(db.credentials.keyFileHash).toBeUndefined();
        await expect(kdbxweb.Kdbx.load(await db.save(), cred())).resolves.toBeTruthy();
    });

    it('is removed by the save, and only on success', async () => {
        const db = await openVault();
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { keyFile: KEYFILE });
        expect(db.credentials.keyFileHash).toBeTruthy();

        // null is the request to remove it, which absence would not express
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { keyFile: null });
        expect(db.credentials.keyFileHash).toBeUndefined();
        await expect(
            kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, cred())
        ).resolves.toBeTruthy();
    });

    it('carries a password and a key file together', async () => {
        const db = await openVault();

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, {
            password: kdbxweb.ProtectedValue.fromString('both'),
            keyFile: KEYFILE,
        });

        const wanted = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('both'));
        await wanted.setKeyFile(KEYFILE);
        await expect(
            kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, wanted)
        ).resolves.toBeTruthy();
    });
});

// The credential revert exists for a save that never reached the file. Past
// the write the file is under the new key, so putting the old one back would
// leave the vault holding a key that opens nothing.
describe('a failure after the write has landed', () => {
    it('keeps the credentials the file was written with', async () => {
        const db = await openVault();
        const electron = (globalThis as any).window.electron;
        const realStat = electron.statFile;
        // The save stats twice: once for conflict detection before the write,
        // once to refresh the baseline after it. Only the second one is past
        // the point of no return
        let stats = 0;
        electron.statFile = async (...args: unknown[]) => {
            if (++stats > 1) throw new Error('stat failed');
            return realStat(...args);
        };
        try {
            await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, {
                password: kdbxweb.ProtectedValue.fromString('rotated'),
            });
        } finally {
            electron.statFile = realStat;
        }

        const rotated = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('rotated'));
        await expect(
            kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, rotated)
        ).resolves.toBeTruthy();
        // And the open vault still writes something that file's key opens
        await expect(kdbxweb.Kdbx.load(await db.save(), rotated)).resolves.toBeTruthy();
    });

    // Anything that throws past the write reaches the same catch as a write
    // that never happened; only the flag tells them apart
    it('keeps them even when the save still ends in the catch', async () => {
        const db = await openVault();
        const w = (globalThis as any).window;
        const realToast = w.showToast;
        w.showToast = () => { throw new Error('toast failed'); };
        try {
            await expect(Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, {
                password: kdbxweb.ProtectedValue.fromString('rotated'),
            })).rejects.toThrow();
        } finally {
            w.showToast = realToast;
        }

        const rotated = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('rotated'));
        await expect(
            kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, rotated)
        ).resolves.toBeTruthy();
        await expect(kdbxweb.Kdbx.load(await db.save(), rotated)).resolves.toBeTruthy();
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, wireConflictResolver, MockEnv } from './helpers';

// The same vault open on two machines, one of which changes the master
// password. The second can no longer read the file at all, and the answer it
// used to get was "could not be merged, overwrite with your version?", whose
// yes put the old password back and threw away everything the first machine
// had written. A re-key is not a conflict to resolve; it is a state to
// recover from, and kdbx4 lets us tell the two apart with certainty.
const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const NEW_PW = 'the-new-one';
const newCred = () => new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(NEW_PW));

// kdbx4, which is what makes the re-key detectable: its header is covered by
// a SHA-256 checked before the key-derived HMAC, so a sound file we cannot
// open is reported as InvalidKey rather than FileCorrupt. AES-KDF rather than
// the argon2 default only because the test environment has no argon2
async function vaultWith(title: string, credentials: kdbxweb.Credentials): Promise<kdbxweb.Kdbx> {
    const db = kdbxweb.Kdbx.create(credentials, 'Vault');
    db.header.setKdf(kdbxweb.Consts.KdfId.Aes);
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', title);
    return db;
}

const titles = (db: kdbxweb.Kdbx): string[] =>
    [...db.getDefaultGroup().allGroupsAndEntries()]
        .filter((i): i is kdbxweb.KdbxEntry => i instanceof kdbxweb.KdbxEntry)
        .map((e) => String(e.fields.get('Title')));

// Machine A's version: same vault identity, re-keyed, with an entry only it has
// A fresh credentials object, never the live vault's: Kdbx.load keeps the one
// it is handed, so re-keying the remote through a shared object would silently
// re-key the vault under test as well
async function rekeyedOnDisk(local: kdbxweb.Kdbx): Promise<Uint8Array> {
    const remote = await kdbxweb.Kdbx.load(await local.save(), cred());
    const entry = remote.createEntry(remote.getDefaultGroup());
    entry.fields.set('Title', 'FromOtherMachine');
    await remote.credentials.setPassword(kdbxweb.ProtectedValue.fromString(NEW_PW));
    return new Uint8Array(await remote.save());
}

beforeEach(() => {
    env.toasts.length = 0;
    env.confirm.calls = 0;
    env.confirm.answer = true;
    wireConflictResolver(Svc, env);
});

describe('a vault re-keyed on another machine', () => {
    it('refuses to save rather than offering to overwrite the new password', async () => {
        const local = await vaultWith('Mine', cred());
        const opened = new Uint8Array(await local.save());
        env.disk.bytes = Buffer.from(opened);
        Svc.setPath('/vault.kdbx', opened);
        await new Promise((r) => setTimeout(r, 0));

        env.disk.bytes = Buffer.from(await rekeyedOnDisk(local));
        env.disk.mtime++;

        await expect(
            Svc.saveDatabase(Svc.convertKdbxToDatabase(local), local)
        ).rejects.toThrow('SAVE_BLOCKED_REKEYED');

        // The destructive prompt was never raised
        expect(env.confirm.calls).toBe(0);
    });

    it('leaves the file on disk under the new password', async () => {
        const local = await vaultWith('Mine', cred());
        const opened = new Uint8Array(await local.save());
        env.disk.bytes = Buffer.from(opened);
        Svc.setPath('/vault.kdbx', opened);
        await new Promise((r) => setTimeout(r, 0));

        const rekeyed = await rekeyedOnDisk(local);
        env.disk.bytes = Buffer.from(rekeyed);
        env.disk.mtime++;

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(local), local).catch(() => {});

        // Still opens with the new password, not the old one
        await expect(kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, cred())).rejects.toThrow();
        const onDisk = await kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, newCred());
        expect(titles(onDisk)).toContain('FromOtherMachine');
    });

    it('recovers with the new password and keeps both sides', async () => {
        const local = await vaultWith('Mine', cred());
        const opened = new Uint8Array(await local.save());
        env.disk.bytes = Buffer.from(opened);
        Svc.setPath('/vault.kdbx', opened);
        await new Promise((r) => setTimeout(r, 0));

        const rekeyed = await rekeyedOnDisk(local);

        // An edit made here that never reached the file
        const localOnly = local.createEntry(local.getDefaultGroup());
        localOnly.fields.set('Title', 'UnsavedHere');

        const outcome = await Svc.recoverFromRekey(local, rekeyed, newCred());
        expect(outcome).toBe('recovered');

        const after = titles(local);
        expect(after).toContain('UnsavedHere');
        expect(after).toContain('FromOtherMachine');
        expect(after).toContain('Mine');
    });

    it('adopts the new key, so the next save writes under it', async () => {
        const local = await vaultWith('Mine', cred());
        const rekeyed = await rekeyedOnDisk(local);

        await Svc.recoverFromRekey(local, rekeyed, newCred());

        const written = await local.save();
        await expect(kdbxweb.Kdbx.load(written, cred())).rejects.toThrow();
        expect(titles(await kdbxweb.Kdbx.load(written, newCred()))).toContain('Mine');
    });

    it('reports a wrong password without disturbing the open vault', async () => {
        const local = await vaultWith('Mine', cred());
        const rekeyed = await rekeyedOnDisk(local);

        const outcome = await Svc.recoverFromRekey(
            local, rekeyed, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('not-it'))
        );
        expect(outcome).toBe('wrong-credentials');
        expect(titles(local)).not.toContain('FromOtherMachine');

        // The old key is still the one the vault holds
        expect(titles(await kdbxweb.Kdbx.load(await local.save(), cred()))).toContain('Mine');
    });
});

describe('a different vault at the same path', () => {
    it('is refused rather than merged in, and the open vault keeps its key', async () => {
        const local = await vaultWith('Mine', cred());
        const stranger = await vaultWith('NotYours', newCred());

        const outcome = await Svc.recoverFromRekey(
            local, new Uint8Array(await stranger.save()), newCred()
        );

        expect(outcome).toBe('different-vault');
        expect(titles(local)).toEqual(['Mine']);
        expect(titles(await kdbxweb.Kdbx.load(await local.save(), cred()))).toEqual(['Mine']);
    });
});

describe('changing the password while the file already changed on disk', () => {
    it('merges the other machine\'s edit instead of offering to discard it', async () => {
        const local = await vaultWith('Mine', cred());
        const opened = new Uint8Array(await local.save());
        env.disk.bytes = Buffer.from(opened);
        Svc.setPath('/vault.kdbx', opened);
        await new Promise((r) => setTimeout(r, 0));

        // Another machine saved an entry, still under the old password
        const remote = await kdbxweb.Kdbx.load(opened.slice().buffer, cred());
        remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'TheirEdit');
        env.disk.bytes = Buffer.from(await remote.save());
        env.disk.mtime++;

        // Now the password is changed here, with that version unmerged
        await Svc.saveDatabase(
            Svc.convertKdbxToDatabase(local), local,
            kdbxweb.ProtectedValue.fromString(NEW_PW)
        );

        // Nothing was thrown away and nothing was asked
        expect(env.confirm.calls).toBe(0);
        const onDisk = await kdbxweb.Kdbx.load(Uint8Array.from(env.disk.bytes!).buffer, newCred());
        expect(titles(onDisk)).toContain('TheirEdit');
        expect(titles(onDisk)).toContain('Mine');
    });

    it('keeps the old password when the write fails', async () => {
        const local = await vaultWith('Mine', cred());
        const opened = new Uint8Array(await local.save());
        env.disk.bytes = Buffer.from(opened);
        Svc.setPath('/vault.kdbx', opened);
        await new Promise((r) => setTimeout(r, 0));

        const electron = (globalThis as any).window.electron;
        const realSave = electron.saveToFile;
        electron.saveToFile = async () => ({ success: false, error: 'disk full' });
        try {
            await expect(Svc.saveDatabase(
                Svc.convertKdbxToDatabase(local), local,
                kdbxweb.ProtectedValue.fromString(NEW_PW)
            )).rejects.toThrow();
        } finally {
            electron.saveToFile = realSave;
        }

        // The vault still holds the password the file has
        expect(await Svc.verifyMasterPassword(local, 'test')).toBe(true);
        expect(titles(await kdbxweb.Kdbx.load(await local.save(), cred()))).toContain('Mine');
    });
});

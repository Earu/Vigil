import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

// kdbx4 uses argon2; wire in the same native implementation the app uses
const argon2 = await import('@node-rs/argon2');
kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
    const hash = await argon2.hashRaw(new Uint8Array(password), {
        memoryCost: memory,
        timeCost: iterations,
        outputLen: length,
        parallelism,
        algorithm: type,
        version: version === 16 ? argon2.Version.V0x10 : argon2.Version.V0x13,
        salt: new Uint8Array(salt),
    });
    return hash.buffer as ArrayBuffer;
});

const pw = (s: string) => new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(s));

const makeDb = async (version: 3 | 4 = 4) => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    if (version === 3) db0.setVersion(3);
    const entry = db0.createEntry(db0.getDefaultGroup());
    entry.fields.set('Title', 'Site');
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('secret'));
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

describe('master password', () => {
    it('verifies the current password', async () => {
        const db = await makeDb();
        expect(await Svc.verifyMasterPassword(db, 'test')).toBe(true);
        expect(await Svc.verifyMasterPassword(db, 'wrong')).toBe(false);
        expect(await Svc.verifyMasterPassword(db, '')).toBe(false);
    });

    it('changes the password; old one stops working', async () => {
        const db = await makeDb();
        await Svc.changeMasterPassword(db, 'brand-new-pass');
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        const bytes = () => Uint8Array.from(env.disk.bytes!).buffer;
        const reloaded = await kdbxweb.Kdbx.load(bytes(), pw('brand-new-pass'));
        expect(reloaded.getDefaultGroup().entries[0].fields.get('Title')).toBe('Site');

        await expect(kdbxweb.Kdbx.load(bytes(), cred())).rejects.toThrow();

        expect(await Svc.verifyMasterPassword(db, 'brand-new-pass')).toBe(true);
    });
});

describe('KDF settings', () => {
    it('reads argon2 parameters from a kdbx4 database', async () => {
        const db = await makeDb();
        const info = Svc.getKdfInfo(db);
        expect(info.type === 'argon2d' || info.type === 'argon2id').toBe(true);
        expect(info.iterations).toBeGreaterThan(0);
        expect(info.memoryMiB).toBeGreaterThan(0);
        expect(info.parallelism).toBeGreaterThan(0);
    });

    it('applies new argon2 parameters and round-trips', async () => {
        const db = await makeDb();
        Svc.setKdf(db, { type: Svc.getKdfInfo(db).type, iterations: 3, memoryMiB: 16, parallelism: 2 });
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        const reloaded = await loadSaved(env);
        expect(Svc.getKdfInfo(reloaded)).toEqual({
            type: Svc.getKdfInfo(db).type, iterations: 3, memoryMiB: 16, parallelism: 2
        });
        expect(reloaded.getDefaultGroup().entries[0].fields.get('Title')).toBe('Site');
    });

    it('switches between argon2d and argon2id', async () => {
        const db = await makeDb();
        const other = Svc.getKdfInfo(db).type === 'argon2d' ? 'argon2id' : 'argon2d';
        Svc.setKdf(db, { type: other, iterations: 2, memoryMiB: 8, parallelism: 1 });
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        const reloaded = await loadSaved(env);
        const info = Svc.getKdfInfo(reloaded);
        expect(info.type).toBe(other);
        expect(info.iterations).toBe(2);
    });

    it('new databases get hardened argon2id defaults, round-trips through save', async () => {
        // mirrors the create-new-database path in PasswordForm
        const db = kdbxweb.Kdbx.create(cred(), 'Fresh');
        Svc.setKdf(db, { type: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 });
        expect(Svc.getKdfInfo(db)).toEqual({ type: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 });

        const reloaded = await kdbxweb.Kdbx.load(await db.save(), cred());
        expect(Svc.getKdfInfo(reloaded)).toEqual({ type: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 });
    });

    it('handles kdbx3 key encryption rounds', async () => {
        const db = await makeDb(3);
        expect(Svc.getKdfInfo(db).type).toBe('aes-kdbx3');
        Svc.setKdf(db, { type: 'aes-kdbx3', iterations: 12345 });
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        const reloaded = await loadSaved(env);
        expect(Svc.getKdfInfo(reloaded)).toEqual({ type: 'aes-kdbx3', iterations: 12345 });
        expect(reloaded.getDefaultGroup().entries[0].fields.get('Title')).toBe('Site');
    });
});

describe('history retention', () => {
    it('trims history to the configured maximum on save', async () => {
        let db = await makeDb(3);
        expect(Svc.getHistoryMaxItems(db)).toBe(10);
        Svc.setHistoryMaxItems(db, 2);

        for (let i = 0; i < 5; i++) {
            const database = Svc.convertKdbxToDatabase(db);
            const edited = { ...database.root.entries[0], title: `Site-${i}` };
            const [updated] = Svc.saveEntry(database, edited, database.root, false);
            await Svc.saveDatabase(updated, db);
            db = await loadSaved(env);
        }

        const entry = db.getDefaultGroup().entries[0];
        expect(entry.fields.get('Title')).toBe('Site-4');
        expect(entry.history.length).toBeLessThanOrEqual(2);
        expect(Svc.getHistoryMaxItems(db)).toBe(2);
    });
});

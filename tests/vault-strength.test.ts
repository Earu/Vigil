import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, MockEnv } from './helpers';

// A vault whose key derivation is too weak is offered a re-encryption at
// unlock, and the whole master key (password, key file, hardware key) is
// changed through one save. Both go through the credentials the file is
// written with, so what the file wants and what the open vault holds must
// never drift apart.
const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

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

const kdf = (partial: Partial<import('../src/services/KeepassDatabaseService').KdfInfo>) => ({
    type: 'argon2id' as const,
    iterations: 3,
    memoryMiB: 64,
    ...partial,
});

// Deterministic stand-in for a YubiKey: the same tag answers the same
// challenge the same way, a different tag is a different key
const responder = (tag: number): kdbxweb.KdbxChallengeResponseFn => async (challenge) => {
    const asked = new Uint8Array(challenge);
    const answer = new Uint8Array(20);
    for (let i = 0; i < answer.length; i++) answer[i] = (asked[i % asked.length] ^ tag) & 0xff;
    return answer.buffer;
};

const withHardwareKey = (tag: number) =>
    new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'), null, responder(tag));

const onDisk = () => Uint8Array.from(env.disk.bytes!).buffer;

async function openVault(version: 3 | 4): Promise<kdbxweb.Kdbx> {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(version);
    const entry = db0.createEntry(db0.getDefaultGroup());
    entry.fields.set('Title', 'Site');
    entry.binaries.set('note.txt', Uint8Array.from([7, 8, 9]));
    const bytes = new Uint8Array(await db0.save());
    env.disk.bytes = Buffer.from(bytes);
    const db = await kdbxweb.Kdbx.load(bytes.slice().buffer, cred());
    Svc.setPath('/vault.kdbx', bytes);
    await new Promise((r) => setTimeout(r, 0));
    return db;
}

describe('what counts as a weak vault', () => {
    it('names the old format, which has no argon2 to tune', () => {
        expect(Svc.kdfWeakness({ type: 'aes-kdbx3', iterations: 60000 })).toEqual({ code: 'old-format' });
    });

    it('names AES key derivation whatever the round count', () => {
        expect(Svc.kdfWeakness({ type: 'aes', iterations: 60_000 })).toEqual({ code: 'aes-kdf' });
        expect(Svc.kdfWeakness({ type: 'aes', iterations: 50_000_000 })).toEqual({ code: 'aes-kdf' });
    });

    it('names argon2 that fits in too little memory to be worth attacking on a GPU', () => {
        expect(Svc.kdfWeakness(kdf({ memoryMiB: 1, iterations: 2 }))).toEqual({ code: 'low-memory', memoryMiB: 1 });
        expect(Svc.kdfWeakness(kdf({ memoryMiB: 16, iterations: 100 }))).toEqual({ code: 'low-memory', memoryMiB: 16 });
    });

    it('names argon2 with the memory but not the passes', () => {
        expect(Svc.kdfWeakness(kdf({ memoryMiB: 32, iterations: 1 })))
            .toEqual({ code: 'low-work', memoryMiB: 32, iterations: 1 });
    });

    it('leaves a sound vault alone', () => {
        expect(Svc.kdfWeakness(Svc.RECOMMENDED_KDF)).toBeNull();
        expect(Svc.kdfWeakness(kdf({ memoryMiB: 64, iterations: 1 }))).toBeNull();
        expect(Svc.kdfWeakness(kdf({ type: 'argon2d', memoryMiB: 256, iterations: 4 }))).toBeNull();
    });
});

describe('re-encrypting a weak vault', () => {
    it('upgrades the old format and keeps everything in it', async () => {
        const db = await openVault(3);
        expect(Svc.vaultWeakness(db)).toEqual({ code: 'old-format' });

        Svc.applyRecommendedKdf(db);
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        // Same password, new file: nothing about the master key changed
        const reloaded = await kdbxweb.Kdbx.load(onDisk(), cred());
        expect(reloaded.header.versionMajor).toBe(4);
        expect(reloaded.header.versionMinor).toBe(1);
        expect(Svc.vaultWeakness(reloaded)).toBeNull();
        expect(Svc.getKdfInfo(reloaded)).toEqual(Svc.RECOMMENDED_KDF);

        const entry = reloaded.getDefaultGroup().entries[0];
        expect(entry.fields.get('Title')).toBe('Site');
        expect(entry.binaries.get('note.txt')).toBeTruthy();
    });

    it('raises argon2 parameters that were left too low', async () => {
        const db = await openVault(4);
        Svc.setKdf(db, kdf({ type: 'argon2d', memoryMiB: 1, iterations: 2 }));
        expect(Svc.vaultWeakness(db)).toEqual({ code: 'low-memory', memoryMiB: 1 });

        Svc.applyRecommendedKdf(db);
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db);

        const reloaded = await kdbxweb.Kdbx.load(onDisk(), cred());
        expect(Svc.getKdfInfo(reloaded)).toEqual(Svc.RECOMMENDED_KDF);
    });
});

describe('a hardware key change', () => {
    // usesHardwareKey and the save both reach kdbxweb's private
    // _challengeResponse field, which no public API exposes. A rename in a
    // kdbxweb upgrade would leave the reads answering false and the writes
    // landing on a dead property, so both directions are pinned here: this
    // one for credentials built at unlock, the ones below for the save
    it('sees the key on credentials the unlock screen built', async () => {
        const db = kdbxweb.Kdbx.create(withHardwareKey(1), 'Vault');
        expect(Svc.usesHardwareKey(db)).toBe(true);
        expect(Svc.usesHardwareKey(kdbxweb.Kdbx.create(cred(), 'Vault'))).toBe(false);
    });


    it('is applied by the save, so the file and the vault agree', async () => {
        const db = await openVault(4);

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { challengeResponse: responder(1) });

        await expect(kdbxweb.Kdbx.load(onDisk(), cred())).rejects.toThrow();
        await expect(kdbxweb.Kdbx.load(onDisk(), withHardwareKey(2))).rejects.toThrow();
        await expect(kdbxweb.Kdbx.load(onDisk(), withHardwareKey(1))).resolves.toBeTruthy();
        expect(Svc.usesHardwareKey(db)).toBe(true);
    });

    it('rides along with a password and a key file', async () => {
        const db = await openVault(4);
        const keyFile = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, {
            password: kdbxweb.ProtectedValue.fromString('rotated'),
            keyFile,
            challengeResponse: responder(1),
        });

        const wanted = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('rotated'), keyFile, responder(1)
        );
        await expect(kdbxweb.Kdbx.load(onDisk(), wanted)).resolves.toBeTruthy();
    });

    it('is removed by the save, which absence would not express', async () => {
        const db = await openVault(4);
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { challengeResponse: responder(1) });

        // Absent: the vault keeps the key it has
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, {});
        await expect(kdbxweb.Kdbx.load(onDisk(), withHardwareKey(1))).resolves.toBeTruthy();

        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { challengeResponse: null });
        expect(Svc.usesHardwareKey(db)).toBe(false);
        await expect(kdbxweb.Kdbx.load(onDisk(), cred())).resolves.toBeTruthy();
    });

    it('leaves the vault on the old key when the write fails', async () => {
        const db = await openVault(4);
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { challengeResponse: responder(1) });

        const electron = (globalThis as any).window.electron;
        const realSave = electron.saveToFile;
        electron.saveToFile = async () => ({ success: false, error: 'locked' });
        try {
            await expect(
                Svc.saveDatabase(Svc.convertKdbxToDatabase(db), db, { challengeResponse: responder(2) })
            ).rejects.toThrow();
        } finally {
            electron.saveToFile = realSave;
        }

        // No half-applied credential: what the vault writes is still what the
        // file on disk wants
        await expect(kdbxweb.Kdbx.load(await db.save(), withHardwareKey(1))).resolves.toBeTruthy();
    });
});

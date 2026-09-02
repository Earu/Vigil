import { describe, it, expect } from 'vitest';
import { hashPassword, checkArgon2Params, MAX_WORK_KIB_PASSES } from '../electron/src/crypto';
import { installMockWindow } from './helpers';

installMockWindow();
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');

const password = new TextEncoder().encode('pw').buffer as ArrayBuffer;
const salt = new Uint8Array(32).fill(7).buffer as ArrayBuffer;

// Argon2id, version 0x13, the shapes kdbxweb sends (memory in KiB)
const run = (memory: number, iterations = 2, parallelism = 1, length = 32) =>
    hashPassword(password, salt, memory, iterations, length, parallelism, 2, 19);

const MiB = 1024;
const GiB = 1024 * MiB;
const machine = (gib: number) => gib * 1024 * 1024 * 1024;

describe('argon2 parameter limits', () => {
    // The guard's own floors, so the real KDF runs at trivial cost
    it('hashes with valid parameters', async () => {
        const hash = await run(8, 1, 1, 16);
        expect(hash.length).toBe(16);
    });

    // A hostile header must fail this one unlock, never allocate first.
    // The cap sits at the settings UI's own maximum (4096 MiB), so
    // everything Vigil can write stays openable
    it('rejects a header demanding absurd memory', async () => {
        await expect(run(16 * GiB)).rejects.toThrow(/Unreasonable Argon2/);
    });

    it('rejects absurd iterations, parallelism and output length', async () => {
        await expect(run(8, 1e9)).rejects.toThrow(/Unreasonable Argon2/);
        await expect(run(8, 1, 10000)).rejects.toThrow(/Unreasonable Argon2/);
        await expect(run(8, 1, 1, 4096)).rejects.toThrow(/Unreasonable Argon2/);
        await expect(run(NaN)).rejects.toThrow(/Unreasonable Argon2/);
    });

    it('rejects a header that passes every single cap but asks for years of work', async () => {
        // 4 GiB and a million iterations each sit inside their own cap
        await expect(run(4 * GiB, 1_000_000)).rejects.toThrow(/more work than this app will do/);
    });
});

describe('argon2 work budget', () => {
    const check = (memoryKiB: number, iterations: number, totalMemoryGiB = 32) =>
        () => checkArgon2Params(memoryKiB, iterations, 4, 32, machine(totalMemoryGiB));

    it('admits the heaviest vault a real user runs', () => {
        expect(check(1 * GiB, 10)).not.toThrow();
        expect(check(4 * GiB, 16)).not.toThrow();
        expect(check(64 * MiB, 1000)).not.toThrow();
    });

    it('draws the line at memory times iterations', () => {
        expect(check(4 * GiB, 17)).toThrow(/more work/);
        expect(check(256 * MiB, 257)).toThrow(/more work/);
        expect(check(256 * MiB, 256)).not.toThrow();
    });

    it('refuses an allocation past half the machine', () => {
        expect(check(4 * GiB, 1, 8)).not.toThrow();
        expect(check(4 * GiB, 1, 4)).toThrow(/MiB of memory on a machine/);
        expect(check(2 * GiB, 1, 4)).not.toThrow();
    });

    it('is the same budget the settings UI enforces', () => {
        expect(KeepassDatabaseService.ARGON2_MAX_WORK_MIB_PASSES * 1024).toBe(MAX_WORK_KIB_PASSES);
    });

    it('keeps the settings UI from writing a vault the app would refuse', () => {
        const svc = KeepassDatabaseService;
        expect(svc.argon2WorkExceeded({ type: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 })).toBe(false);
        expect(svc.argon2WorkExceeded({ type: 'argon2id', iterations: 1000, memoryMiB: 4096, parallelism: 4 })).toBe(true);
        expect(svc.argon2WorkExceeded({ type: 'argon2id', iterations: 16, memoryMiB: 4096, parallelism: 4 })).toBe(false);
        // AES-KDF rounds are not memory bound and not budgeted here
        expect(svc.argon2WorkExceeded({ type: 'aes', iterations: 100_000_000 })).toBe(false);
    });
});

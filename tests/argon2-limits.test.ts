import { describe, it, expect } from 'vitest';
import { hashPassword } from '../electron/src/crypto';

const password = new TextEncoder().encode('pw').buffer as ArrayBuffer;
const salt = new Uint8Array(32).fill(7).buffer as ArrayBuffer;

// Argon2id, version 0x13, the shapes kdbxweb sends (memory in KiB)
const run = (memory: number, iterations = 2, parallelism = 1, length = 32) =>
    hashPassword(password, salt, memory, iterations, length, parallelism, 2, 19);

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
        await expect(run(16 * 1024 * 1024)).rejects.toThrow(/Unreasonable Argon2/);
    });

    it('rejects absurd iterations, parallelism and output length', async () => {
        await expect(run(8, 1e9)).rejects.toThrow(/Unreasonable Argon2/);
        await expect(run(8, 1, 10000)).rejects.toThrow(/Unreasonable Argon2/);
        await expect(run(8, 1, 1, 4096)).rejects.toThrow(/Unreasonable Argon2/);
        await expect(run(NaN)).rejects.toThrow(/Unreasonable Argon2/);
    });
});

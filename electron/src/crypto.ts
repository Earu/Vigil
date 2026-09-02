import * as argon2 from '@node-rs/argon2';

// The KDF parameters come from the kdbx header, i.e. from a file the user
// may have been sent. Unchecked, a header claiming a huge memory cost OOM
// kills the main process (every window, unsaved edits and all) instead of
// failing one unlock. Only memory can do that (the hash runs off the main
// thread, so CPU cost merely slows one unlock), so the memory cap is the
// tight one: it must admit everything Vigil's own KDF settings UI can
// produce (4096 MiB, Settings.tsx) while the CPU-side caps are generous
// enough for any vault another app could legitimately write. Memory arrives
// in KiB (kdbxweb converts from the header's bytes)
const MAX_MEMORY_KIB = 4 * 1024 * 1024; // 4 GiB, the settings UI maximum
const MAX_ITERATIONS = 1_000_000;
const MAX_PARALLELISM = 256;

// NaN fails every comparison, so the range test needs no explicit isFinite
const inRange = (value: number, min: number, max: number): boolean =>
    value >= min && value <= max;

export async function hashPassword(
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: number,
    version: number
): Promise<Uint8Array> {
    if (!inRange(memory, 8, MAX_MEMORY_KIB) ||
        !inRange(iterations, 1, MAX_ITERATIONS) ||
        !inRange(parallelism, 1, MAX_PARALLELISM) ||
        !inRange(length, 16, 128)) {
        throw new Error('Unreasonable Argon2 parameters in the database header');
    }
    const hash = await argon2.hashRaw(new Uint8Array(password), {
        memoryCost: memory,
        timeCost: iterations,
        outputLen: length,
        parallelism: parallelism,
        algorithm: type,
        version: version == 16 ? argon2.Version.V0x10 : argon2.Version.V0x13,
        salt: new Uint8Array(salt),
    });

    return hash;
}
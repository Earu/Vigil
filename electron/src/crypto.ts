import * as argon2 from '@node-rs/argon2';
import os from 'os';

// The KDF parameters come from the kdbx header, i.e. from a file the user
// may have been sent. Unchecked, a header claiming a huge memory cost OOM
// kills the main process (every window, unsaved edits and all) instead of
// failing one unlock, and one claiming enough iterations keeps the KDF busy
// for years, which is a hang nothing but a restart ends. So two caps:
//
// Memory: whatever the settings UI can produce (4096 MiB, Settings.tsx), and
// never more than half of what the machine has, because an allocation past
// that is the OOM kill dressed up as a slow unlock.
//
// Work: memory times iterations, which is what the run time is proportional
// to (parallelism splits the same memory across lanes and does not add to
// it). 64 GiB-passes is a couple of minutes on ordinary hardware and well
// above anything a real vault carries; the same budget is enforced on the
// settings side (KeepassDatabaseService.ARGON2_MAX_WORK_MIB_PASSES) so Vigil
// cannot write a vault it would then refuse to open. Memory arrives in KiB
// (kdbxweb converts from the header's bytes)
const MAX_MEMORY_KIB = 4 * 1024 * 1024; // 4 GiB, the settings UI maximum
export const MAX_WORK_KIB_PASSES = 64 * 1024 * 1024; // 64 GiB-passes
const MAX_ITERATIONS = 1_000_000;
const MAX_PARALLELISM = 256;

// NaN fails every comparison, so the range test needs no explicit isFinite
const inRange = (value: number, min: number, max: number): boolean =>
    value >= min && value <= max;

// Pure, so the tests can cover the boundaries without running the KDF
export function checkArgon2Params(
    memory: number,
    iterations: number,
    parallelism: number,
    length: number,
    totalMemoryBytes: number = os.totalmem()
): void {
    if (!inRange(memory, 8, MAX_MEMORY_KIB) ||
        !inRange(iterations, 1, MAX_ITERATIONS) ||
        !inRange(parallelism, 1, MAX_PARALLELISM) ||
        !inRange(length, 16, 128)) {
        throw new Error('Unreasonable Argon2 parameters in the database header');
    }
    const machineCapKiB = Math.floor(totalMemoryBytes / 2 / 1024);
    if (memory > machineCapKiB) {
        throw new Error(`Unreasonable Argon2 parameters in the database header: ${Math.round(memory / 1024)} MiB of memory on a machine with ${Math.round(totalMemoryBytes / 1024 / 1024)} MiB`);
    }
    if (memory * iterations > MAX_WORK_KIB_PASSES) {
        throw new Error(`Unreasonable Argon2 parameters in the database header: ${Math.round(memory / 1024)} MiB x ${iterations} iterations is more work than this app will do`);
    }
}

export async function hashPassword(
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: number,
    version: number,
    abortSignal?: AbortSignal
): Promise<Uint8Array> {
    checkArgon2Params(memory, iterations, parallelism, length);
    const hash = await argon2.hashRaw(new Uint8Array(password), {
        memoryCost: memory,
        timeCost: iterations,
        outputLen: length,
        parallelism: parallelism,
        algorithm: type,
        version: version == 16 ? argon2.Version.V0x10 : argon2.Version.V0x13,
        salt: new Uint8Array(salt),
    }, abortSignal);

    return hash;
}

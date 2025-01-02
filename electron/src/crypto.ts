import * as argon2 from '@node-rs/argon2';

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
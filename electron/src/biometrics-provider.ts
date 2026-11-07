export type QuickUnlockMethod = 'touch-id' | 'windows-hello' | 'pin';

export interface UnlockTarget {
    account: string;
    dbPath: string;
    dbName: string;
}

export interface KeyMaterial {
    secret: Buffer;
    binding: Buffer;
}

export interface SessionSeal {
    blob: string;
    salt: Buffer;
}

export class ArmError extends Error {}

export type ReleaseFailure = 'canceled' | 'failed' | 'gone' | 'wrong-pin' | 'revoked';

export class ReleaseError extends Error {
    constructor(public readonly reason: ReleaseFailure, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
    }
}

export interface PersistentCodec {
    isBlob(stored: string): boolean;
    binding(stored: string): Buffer;
    sealer(): ((password: string, material: KeyMaterial) => string) | null;
    opener(): ((stored: string, secret: Buffer) => string) | null;
    retireAll?(): void;
}

export interface SessionCodec {
    seal(password: string, material: KeyMaterial): SessionSeal;
    binding(sealed: SessionSeal): Buffer;
    open(sealed: SessionSeal, secret: Buffer): string;
}

export interface QuickUnlockProvider {
    readonly id: QuickUnlockMethod;
    readonly method: string;
    readonly needsPin: boolean;
    readonly sessionMarker: string;
    readonly persistent: PersistentCodec;
    readonly session: SessionCodec;
    supported(): boolean;
    biometryType(): string;
    refusal(): Promise<string | null>;
    minPinLength?(): Promise<number>;
    arm(target: UnlockTarget, confirm: boolean, pin?: string): Promise<KeyMaterial>;
    release(target: UnlockTarget, binding: Buffer, pin?: string): Promise<Buffer>;
    retire(account: string): Promise<void>;
    remove(target: UnlockTarget): Promise<void>;
}

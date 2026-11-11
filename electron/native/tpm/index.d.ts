export type TpmCode = 'wrong-pin' | 'locked-out' | 'not-found' | 'unavailable' | 'tampered' | 'bad-input' | 'error';

export type TpmResult<K extends string> =
    | ({ ok: true } & { [key in K]: Buffer })
    | { ok: false; code: TpmCode; status: number };

export function interpret(platform: string, status: number): TpmCode | 'ok';
export const platform: 'win' | 'linux' | 'stub' | 'none';
export function isLoaded(): boolean;
export function probe(): { ok: true } | { ok: false; code: TpmCode; status: number };
export function seal(name: string, data: Buffer, pin: string): Promise<TpmResult<'sealed'>>;
export function unseal(name: string, pin: string, sealed: Buffer): Promise<TpmResult<'data'>>;
export function remove(name: string): Promise<TpmResult<'data'>>;

export type LockoutResult =
    | { ok: true; lockoutAuthSet: boolean; maxTries: number; recoveryInterval: number; lockoutRecovery: number; failures: number }
    | { ok: false; code: TpmCode; status: number };

export interface LockoutLimits {
    maxTries: number;
    recoveryInterval: number;
    lockoutRecovery: number;
}

export function parseLockout(data: Buffer): LockoutResult;
export function lockout(): Promise<LockoutResult>;
export function setLockout(auth: Buffer, limits?: LockoutLimits | null): Promise<TpmResult<'data'>>;

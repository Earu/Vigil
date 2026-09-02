// Surface of index.js, so biometrics.ts can import it as a typed module and
// the tests can substitute a fake with the same shape

export type TouchIdCode =
    | 'canceled' | 'auth-failed' | 'not-found' | 'duplicate'
    | 'missing-entitlement' | 'unavailable' | 'error';

export type TouchIdResult<T = undefined> =
    | ({ ok: true } & (T extends undefined ? {} : { data: T }))
    | { ok: false; code: TouchIdCode; status?: number };

export interface TouchIdAvailability {
    usable: boolean;
    biometry: boolean;
    devicePasscode: boolean;
    biometryType: string;
}

export const STATUS: Record<string, number>;
export function interpret(result: unknown): TouchIdResult<Buffer>;
export function interpretPresence(result: unknown): { ok: true; present: boolean } | { ok: false; code: TouchIdCode; status?: number };
export function describeAvailability(raw: unknown): TouchIdAvailability;
export function isLoaded(): boolean;
export function availability(): TouchIdAvailability;
export function setSecret(account: string, data: Buffer): Promise<TouchIdResult<Buffer>>;
export function getSecret(account: string, prompt: string): Promise<TouchIdResult<Buffer>>;
export function deleteSecret(account: string): Promise<TouchIdResult<Buffer>>;
export function hasSecret(account: string): Promise<{ ok: true; present: boolean } | { ok: false; code: TouchIdCode; status?: number }>;

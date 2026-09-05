// Surface of index.js, so yubikey-oath.ts can import it as a typed module and
// the tests can substitute a fake with the same shape

export type PcscCode =
    | 'ok'
    | 'no-service'
    | 'no-reader'
    | 'no-card'
    | 'reset'
    | 'sharing-violation'
    | 'proto-mismatch'
    | 'not-transacted'
    | 'timeout'
    | 'cancelled'
    | 'pcsc-error'
    // Not from PC/SC: the addon is not built, the handle was already
    // disconnected, or a call overlapped another on the same card
    | 'unavailable'
    | 'closed'
    | 'busy';

export class PcscError extends Error {
    code: PcscCode;
    rv?: number;
}

export interface Card {
    readonly handle: number;
    // SCARD_PROTOCOL_T0 (1) or SCARD_PROTOCOL_T1 (2), whichever the card negotiated
    readonly protocol: number;
    // Full response including the two status word bytes
    transmit(apdu: Uint8Array): Promise<Uint8Array>;
    beginTransaction(): Promise<void>;
    endTransaction(): Promise<void>;
    disconnect(): Promise<void>;
}

export const RV: Record<string, number>;
export function interpret(rv: number): PcscCode;
export function isLoaded(): boolean;
// Empty when nothing is plugged in; rejects only when PC/SC itself is unusable
export function listReaders(): Promise<string[]>;
export function connect(reader: string, options?: { shared?: boolean }): Promise<Card>;

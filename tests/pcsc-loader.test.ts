import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpret, RV, PcscError } = require('../electron/native/pcsc/index.js');

// The addon reports raw WinSCard return codes; these are the names the OATH
// driver branches on. The values are Microsoft's, copied verbatim by
// pcsclite, so one table serves every platform

describe('pcsc return code interpretation', () => {
    it('names the states the driver acts on', () => {
        expect(interpret(RV.SUCCESS)).toBe('ok');
        expect(interpret(RV.NO_SERVICE)).toBe('no-service');
        expect(interpret(RV.SERVICE_STOPPED)).toBe('no-service');
        expect(interpret(RV.NO_READERS_AVAILABLE)).toBe('no-reader');
        expect(interpret(RV.UNKNOWN_READER)).toBe('no-reader');
        expect(interpret(RV.NO_SMARTCARD)).toBe('no-card');
        expect(interpret(RV.REMOVED_CARD)).toBe('no-card');
        expect(interpret(RV.RESET_CARD)).toBe('reset');
        expect(interpret(RV.SHARING_VIOLATION)).toBe('sharing-violation');
        expect(interpret(RV.PROTO_MISMATCH)).toBe('proto-mismatch');
        expect(interpret(RV.TIMEOUT)).toBe('timeout');
    });

    // The two codes a second process contending for the card produces; the
    // driver retries on both rather than reporting a missing service
    it('keeps contention distinct from a missing service', () => {
        expect(interpret(0x8010000f)).toBe('proto-mismatch');
        expect(interpret(0x8010000b)).toBe('sharing-violation');
        expect(interpret(0x8010001d)).toBe('no-service');
    });

    it('reports codes it has no name for without crashing', () => {
        expect(interpret(0x80100042)).toBe('pcsc-error');
        expect(interpret(-1)).toBe('pcsc-error');
        expect(interpret(undefined)).toBe('pcsc-error');
    });

    it('carries the code and raw value on the error', () => {
        const error = new PcscError('no-service', RV.NO_SERVICE);
        expect(error.code).toBe('no-service');
        expect(error.rv).toBe(0x8010001d);
        expect(error.message).toBe('no-service (0x8010001d)');
        expect(error.name).toBe('PcscError');
        // Errors that do not come from PC/SC have no raw value
        expect(new PcscError('unavailable').message).toBe('unavailable');
    });
});

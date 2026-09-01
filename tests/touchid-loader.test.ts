import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpret, interpretPresence, describeAvailability, STATUS } = require('../electron/native/touchid/index.js');

describe('touchid status interpretation', () => {
    it('maps success with data', () => {
        const data = Buffer.from('secret');
        expect(interpret({ status: STATUS.OK, data })).toEqual({ ok: true, data });
    });

    it('maps the outcomes the app branches on', () => {
        expect(interpret({ status: STATUS.USER_CANCELED })).toEqual({ ok: false, code: 'canceled' });
        expect(interpret({ status: STATUS.ITEM_NOT_FOUND })).toEqual({ ok: false, code: 'not-found' });
        expect(interpret({ status: STATUS.AUTH_FAILED })).toEqual({ ok: false, code: 'auth-failed' });
        expect(interpret({ status: STATUS.DUPLICATE_ITEM })).toEqual({ ok: false, code: 'duplicate' });
        expect(interpret({ status: STATUS.MISSING_ENTITLEMENT })).toEqual({ ok: false, code: 'missing-entitlement' });
        expect(interpret({ status: STATUS.UNIMPLEMENTED })).toEqual({ ok: false, code: 'unavailable' });
    });

    // A silent op that would have needed a prompt must not look like a
    // missing item: the caller deletes the stored blob on 'not-found'
    it('does not mistake a suppressed prompt for a missing item', () => {
        expect(interpret({ status: STATUS.INTERACTION_NOT_ALLOWED })).toEqual({ ok: false, code: 'auth-failed' });
    });

    it('reports unknown statuses without crashing', () => {
        // errSecDecode, one of the many statuses the app has no branch for
        expect(interpret({ status: -26275 })).toEqual({ ok: false, code: 'error', status: -26275 });
        expect(interpret(undefined)).toEqual({ ok: false, code: 'unavailable' });
        expect(interpret({})).toEqual({ ok: false, code: 'unavailable' });
    });
});

describe('touchid availability', () => {
    it('is usable when either factor in the access control can be satisfied', () => {
        expect(describeAvailability({ biometry: true, devicePasscode: false, biometryType: 1 }))
            .toEqual({ usable: true, biometry: true, devicePasscode: false, biometryType: 'touch-id' });
        expect(describeAvailability({ biometry: false, devicePasscode: true, biometryType: 0 }))
            .toEqual({ usable: true, biometry: false, devicePasscode: true, biometryType: 'none' });
    });

    it('is unusable with neither factor, and on a machine that reports nothing', () => {
        expect(describeAvailability({ biometry: false, devicePasscode: false, biometryType: 0 }).usable).toBe(false);
        expect(describeAvailability(null).usable).toBe(false);
        expect(describeAvailability(undefined).biometryType).toBe('none');
    });
});

// Measured against a signed, entitled build: a non-interactive query that
// matches a biometry-gated item reports INTERACTION_NOT_ALLOWED, not success
describe('touchid presence check', () => {
    it('treats a suppressed prompt as proof the item is there', () => {
        expect(interpretPresence({ status: STATUS.INTERACTION_NOT_ALLOWED })).toEqual({ ok: true, present: true });
        expect(interpretPresence({ status: STATUS.OK })).toEqual({ ok: true, present: true });
    });

    it('reports a genuinely missing item as absent, not as an error', () => {
        expect(interpretPresence({ status: STATUS.ITEM_NOT_FOUND })).toEqual({ ok: true, present: false });
    });

    it('still surfaces the failures that are not about presence', () => {
        expect(interpretPresence({ status: STATUS.MISSING_ENTITLEMENT }))
            .toEqual({ ok: false, code: 'missing-entitlement' });
        expect(interpretPresence(undefined)).toEqual({ ok: false, code: 'unavailable' });
    });
});

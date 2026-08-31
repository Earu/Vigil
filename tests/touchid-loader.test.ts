import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpret, STATUS } = require('../electron/native/touchid/index.js');

describe('touchid status interpretation', () => {
    it('maps success with data', () => {
        const data = Buffer.from('secret');
        expect(interpret({ status: STATUS.OK, data })).toEqual({ ok: true, data });
    });

    it('maps the outcomes the app branches on', () => {
        expect(interpret({ status: STATUS.USER_CANCELED })).toEqual({ ok: false, code: 'canceled' });
        expect(interpret({ status: STATUS.ITEM_NOT_FOUND })).toEqual({ ok: false, code: 'not-found' });
        expect(interpret({ status: STATUS.MISSING_ENTITLEMENT })).toEqual({ ok: false, code: 'missing-entitlement' });
        expect(interpret({ status: STATUS.UNIMPLEMENTED })).toEqual({ ok: false, code: 'unavailable' });
    });

    it('reports unknown statuses without crashing', () => {
        expect(interpret({ status: -25293 })).toEqual({ ok: false, code: 'error', status: -25293 });
        expect(interpret(undefined)).toEqual({ ok: false, code: 'unavailable' });
        expect(interpret({})).toEqual({ ok: false, code: 'unavailable' });
    });
});

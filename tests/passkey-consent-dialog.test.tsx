// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { PasskeyConsentDialog } from '../src/components/PasskeyConsentDialog';
import { PasskeyConsentRequest } from '../src/services/BrowserIntegrationService';
import { expectNoA11yViolations } from './a11y';

// The dialog names the relying party the ceremony is for. That describes the
// request while the page asking belongs to that party, which is the ordinary
// case and the only one validateRpId's first two branches accept.
//
// Its third branch accepts an rpId the caller is unrelated to when the
// relying party lists the caller as a related origin, and that list arrives
// in the request rather than being checked here. So the one case where rpId
// and origin disagree is the one case the user has to be told about: without
// it the dialog reads "bank.example wants to sign you in" for a page served
// from somewhere else entirely.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const get = (overrides: Partial<PasskeyConsentRequest> = {}): PasskeyConsentRequest => ({
    kind: 'get',
    rpId: 'bank.example',
    origin: 'https://bank.example',
    entries: [{ title: 'Bank', username: 'alice', credentialId: 'abc' }],
    ...overrides,
});

const register = (overrides: Partial<PasskeyConsentRequest> = {}): PasskeyConsentRequest => ({
    kind: 'register',
    rpId: 'bank.example',
    origin: 'https://bank.example',
    username: 'alice',
    ...overrides,
});

const show = (request: PasskeyConsentRequest) =>
    render(<PasskeyConsentDialog request={request} onSubmit={() => {}} onCancel={() => {}} />);

describe('a page that belongs to the relying party', () => {
    it('says nothing about the origin, which would only repeat the rpId', () => {
        const { queryByText } = show(get());
        expect(queryByText(/The page asking is/)).toBeNull();
    });

    it('says nothing for a subdomain either', () => {
        const { queryByText } = show(get({ origin: 'https://login.bank.example' }));
        expect(queryByText(/The page asking is/)).toBeNull();
    });
});

describe('a page the relying party merely lists as related', () => {
    it('names the origin on an assertion', () => {
        const { getByText } = show(get({ origin: 'https://evil.example' }));
        expect(getByText(/which is not part of bank\.example/)).toBeTruthy();
        expect(getByText('https://evil.example')).toBeTruthy();
    });

    it('names it on a registration too', () => {
        const { getByText } = show(register({ origin: 'https://evil.example' }));
        expect(getByText(/which is not part of bank\.example/)).toBeTruthy();
        expect(getByText('https://evil.example')).toBeTruthy();
    });

    it('has no accessibility violations', async () => {
        const { container } = show(get({ origin: 'https://evil.example' }));
        await expectNoA11yViolations(container);
    });
});

// Whatever else the dialog says, the button a stray keypress reaches must not
// be the one that mints or asserts a credential
describe('the default action', () => {
    it('is Deny on a registration', () => {
        const { getByText } = show(register({ origin: 'https://evil.example' }));
        expect(document.activeElement).toBe(getByText('Deny'));
    });
});

// Both of these reach the dialog as text, so neither may be grown until the
// question scrolls off the top and only the sender's text sits above the
// buttons. The ceremony bounds them at a DNS name's length; the dialog shows
// the normalized origin, which drops the path the bound does not cover
describe('what the dialog is willing to render', () => {
    it('shows the origin without its path', () => {
        const { getByText, queryByText } = show(get({
            origin: 'https://evil.example/' + 'p'.repeat(2000),
        }));
        expect(getByText('https://evil.example')).toBeTruthy();
        expect(queryByText(/pppp/)).toBeNull();
    });
});

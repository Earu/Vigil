// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { SharePanel } from '../src/components/PasswordView/SharePanel';
import { ActiveShare, SecretShareService } from '../src/services/SecretShareService';
import { expectNoA11yViolations } from './a11y';

// What the sender reads out when the recipient asks. The code is derived on
// demand, so the panel holds no state of its own and consumes nothing.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const WINDOW = 24 * 3_600_000;

const share = (over: Partial<ActiveShare> = {}): ActiveShare => ({
    id: 'share-1',
    secret: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    phrase: '',
    schedule: {
        start: Math.floor(Date.now() / WINDOW) * WINDOW,
        windowMs: WINDOW,
        count: 1,
        codeLength: SecretShareService.CODE_LENGTH,
        hasPhrase: false,
    },
    recipient: 'Anna',
    createdAt: new Date().toISOString(),
    ...over,
});

describe('SharePanel', () => {
    it('shows the code for the window it is in, and no next one when there is only the one', async () => {
        const { container, queryByText, getByText } = render(<SharePanel share={share()} />);

        await waitFor(() => expect(container.querySelector('.share-code')?.textContent).toMatch(/^000(-[0-9A-Z]{5}){3}$/));
        expect(queryByText('Show the next code')).toBeNull();
        expect(getByText(/It stops working in/).textContent).toMatch(/hours\.$/);
        await expectNoA11yViolations(container);
    });

    it('offers the next code when the share has more than one window', async () => {
        const many = share({ schedule: { ...share().schedule!, windowMs: 3_600_000, count: 24 } });
        const { container, getByText } = render(<SharePanel share={many} />);

        await waitFor(() => expect(container.querySelector('.share-code')).toBeTruthy());
        const first = container.querySelector('.share-code')!.textContent;

        fireEvent.click(getByText('Show the next code'));
        await waitFor(() => expect(container.querySelectorAll('.share-code')).toHaveLength(2));
        const next = container.querySelectorAll('.share-code')[1].textContent;
        expect(next).not.toBe(first);
        // The window index leads the code, so the recipient's page knows which
        // one it is being given
        expect(next!.slice(0, 3)).not.toBe(first!.slice(0, 3));
    });

    it('says a share is done rather than showing a code that opens nothing', async () => {
        const done = share({ schedule: { ...share().schedule!, start: Date.now() - 5 * WINDOW, count: 2 } });
        const { container, getByText } = render(<SharePanel share={done} />);

        await waitFor(() => expect(getByText(/stopped working on/)).toBeTruthy());
        expect(container.querySelector('.share-code')).toBeNull();
    });

    it('keeps a passphrase from an older share behind a Show, and never in the markup before that', async () => {
        const old = share({ phrase: 'gallon-uphill-cranny-sixfold-anthill-mocking', schedule: null });
        const { container, getByText } = render(<SharePanel share={old} />);

        expect(container.innerHTML).not.toContain('gallon-uphill');
        fireEvent.click(getByText('Show'));
        expect(getByText('gallon-uphill-cranny-sixfold-anthill-mocking')).toBeTruthy();
        expect(container.querySelector('.share-code')).toBeNull();
    });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { confirmDialog } from '../src/services/Dialogs';
import { consentQueue } from '../src/services/ConsentQueue';
import { expectNoA11yViolations } from './a11y';

// The in-app replacement for window.confirm: an alert dialog named by its
// message, Cancel focused first, Escape and lock both answering no.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { cleanup(); consentQueue.clear(); });

describe('ConfirmDialog', () => {
    it('is an alert dialog named by the message with Cancel focused', async () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const { getByRole, getByText, container } = render(
            <ConfirmDialog request={{ message: 'Move the entry "a" to the recycle bin?', confirmLabel: 'Move to Recycle Bin' }} onConfirm={onConfirm} onCancel={onCancel} />
        );
        expect(getByRole('alertdialog', { name: 'Move the entry "a" to the recycle bin?' })).toBeTruthy();
        expect(document.activeElement).toBe(getByText('Cancel'));
        await expectNoA11yViolations(container);
        fireEvent.keyDown(getByText('Cancel'), { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
        fireEvent.click(getByText('Move to Recycle Bin'));
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });
});

describe('confirmDialog', () => {
    it('queues a confirm item and resolves with the answer', async () => {
        const answer = confirmDialog('Sure?', 'Yes');
        const item = consentQueue.getSnapshot()!;
        expect(item.kind).toBe('confirm');
        expect(item.payload).toEqual({ message: 'Sure?', confirmLabel: 'Yes' });
        consentQueue.settle(item.id, true);
        expect(await answer).toBe(true);
    });

    it('answers no when the vault locks underneath it', async () => {
        const answer = confirmDialog('Sure?');
        consentQueue.clear();
        expect(await answer).toBe(false);
    });
});

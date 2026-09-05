// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { ToastContainer } from '../src/components/Toast/Toast';
import { expectNoA11yViolations } from './a11y';

// Toasts are the only feedback channel for saves, clipboard and breach
// results, so they have to reach screen readers.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const show = (message: string, type: 'success' | 'error' | 'info' | 'warning') =>
    act(() => { (window as any).showToast({ message, type, duration: 0 }); });

describe('the toast container', () => {
    it('is a polite live region before any toast exists', () => {
        const { container } = render(<ToastContainer />);
        const region = container.querySelector('.toast-container')!;
        expect(region.getAttribute('role')).toBe('status');
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.hasAttribute('data-modal-exempt')).toBe(true);
    });
});

describe('a toast', () => {
    it('announces success as plain text', async () => {
        const { container } = render(<ToastContainer />);
        show('Saved', 'success');
        const toast = container.querySelector('.toast')!;
        expect(toast.getAttribute('role')).toBeNull();
        expect(toast.textContent).toBe('Saved');
        await expectNoA11yViolations(container);
    });

    it('interrupts for errors and says so', async () => {
        const { container } = render(<ToastContainer />);
        show('Save failed', 'error');
        const toast = container.querySelector('.toast')!;
        expect(toast.getAttribute('role')).toBe('alert');
        expect(toast.textContent).toBe('Error: Save failed');
        await expectNoA11yViolations(container);
    });

    it('can be dismissed when it would otherwise stay', async () => {
        const { container, getByRole, queryByRole } = render(<ToastContainer />);
        show('Checking passwords (1/40)', 'info');
        const dismiss = getByRole('button', { name: 'Dismiss' });
        await expectNoA11yViolations(container);
        fireEvent.click(dismiss);
        expect(container.querySelector('.toast')).toBeNull();
        act(() => { (window as any).showToast({ message: 'Saved', type: 'success', duration: 3000 }); });
        expect(queryByRole('button', { name: 'Dismiss' })).toBeNull();
    });

    it('prefixes warnings', () => {
        const { container } = render(<ToastContainer />);
        show('Vault is read only', 'warning');
        expect(container.querySelector('.toast')!.textContent).toBe('Warning: Vault is read only');
    });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import React, { useState } from 'react';
import { Modal } from '../src/components/Modal';
import { expectNoA11yViolations } from './a11y';

// Every dialog in the app goes through Modal, so this is where dialog
// semantics, the focus trap, Escape and focus restore are proven.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const Harness = ({ onClose, nested, withClose = true }: { onClose?: () => void; nested?: boolean; withClose?: boolean }) => {
    const [open, setOpen] = useState(false);
    const [innerOpen, setInnerOpen] = useState(false);
    const close = () => { setOpen(false); onClose?.(); };
    return (
        <div>
            <div data-testid="bg"><button onClick={() => setOpen(true)}>Open</button></div>
            <div data-testid="live" data-modal-exempt="">status</div>
            {open && (
                <Modal overlayClassName="pairing-overlay" className="pairing-dialog" labelledBy="t" onClose={withClose ? close : undefined}>
                    <h3 id="t">Title</h3>
                    <button onClick={() => setInnerOpen(true)}>First</button>
                    <button>Last</button>
                    {nested && innerOpen && (
                        <Modal overlayClassName="settings-modal-overlay" className="settings-import-modal" labelledBy="t2" onClose={() => setInnerOpen(false)}>
                            <h3 id="t2">Inner</h3>
                            <button>Inner button</button>
                        </Modal>
                    )}
                </Modal>
            )}
        </div>
    );
};

const openIt = (getByText: (t: string) => HTMLElement) => {
    const opener = getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    return opener;
};

describe('a dialog', () => {
    it('is a labelled modal dialog with focus on its first control', async () => {
        const { getByText, container } = render(<Harness />);
        openIt(getByText);
        const dialog = container.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('t');
        expect(document.activeElement).toBe(getByText('First'));
        await expectNoA11yViolations(container);
    });

    it('makes everything behind it inert, except live regions, and undoes it on close', () => {
        const { getByText, getByTestId } = render(<Harness />);
        openIt(getByText);
        expect(getByTestId('bg').hasAttribute('inert')).toBe(true);
        expect(getByTestId('live').hasAttribute('inert')).toBe(false);
        fireEvent.keyDown(getByText('Last'), { key: 'Escape' });
        expect(getByTestId('bg').hasAttribute('inert')).toBe(false);
    });

    it('wraps Tab and Shift+Tab', () => {
        const { getByText } = render(<Harness />);
        openIt(getByText);
        fireEvent.keyDown(getByText('Last'), { key: 'Tab' });
        expect(document.activeElement).toBe(getByText('First'));
        fireEvent.keyDown(getByText('First'), { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(getByText('Last'));
    });

    it('closes on Escape and gives focus back to the opener', () => {
        const onClose = vi.fn();
        const { getByText } = render(<Harness onClose={onClose} />);
        const opener = openIt(getByText);
        fireEvent.keyDown(getByText('First'), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(opener);
    });

    it('ignores Escape when it has no cancel path', () => {
        const { getByText, container } = render(<Harness withClose={false} />);
        openIt(getByText);
        fireEvent.keyDown(getByText('First'), { key: 'Escape' });
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('lets a control keep Escape for itself', () => {
        const onClose = vi.fn();
        const { getByText, container } = render(<Harness onClose={onClose} />);
        openIt(getByText);
        const first = getByText('First');
        first.addEventListener('keydown', (e) => e.preventDefault());
        fireEvent.keyDown(first, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    });
});

describe('a dialog the app opened on its own', () => {
    it('stays quiet until the first key pressed inside it', () => {
        const { getByRole, getByText } = render(
            <Modal overlayClassName="pairing-overlay" className="pairing-dialog" labelledBy="q" quietInitialFocus initialFocus="container">
                <h3 id="q">Report</h3>
                <button>Close</button>
            </Modal>
        );
        const dialog = getByRole('dialog');
        expect(document.activeElement).toBe(dialog);
        expect(dialog.hasAttribute('data-quiet-focus')).toBe(true);
        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
        expect(dialog.hasAttribute('data-quiet-focus')).toBe(false);
        expect(document.activeElement).toBe(getByText('Close'));
    });
});

describe('a nested dialog', () => {
    it('closes alone on Escape and returns focus to the outer one', () => {
        const onClose = vi.fn();
        const { getByText, queryByText } = render(<Harness onClose={onClose} nested />);
        openIt(getByText);
        act(() => { fireEvent.click(getByText('First')); });
        expect(document.activeElement).toBe(getByText('Inner button'));
        fireEvent.keyDown(getByText('Inner button'), { key: 'Escape' });
        expect(queryByText('Inner')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(getByText('First'));
        expect(getByText('Last').closest('[inert]')).toBeNull();
    });
});

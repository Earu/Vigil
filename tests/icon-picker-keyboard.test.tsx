// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { IconPicker } from '../src/components/PasswordView/IconPicker';
import { KEEPASS_ICON_COUNT } from '../src/icons/keepass/KeePassIcons';
import { expectNoA11yViolations } from './a11y';

// Sixty-nine icons are one Tab stop with arrows inside, not sixty-nine stops.

vi.mock('../src/services/KeepassDatabaseService', () => ({
    KeepassDatabaseService: {
        listCustomIcons: () => [{ id: 'c1', url: 'data:,a' }, { id: 'c2', url: 'data:,b' }],
        stageCustomIcon: () => 'staged',
    },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const COLUMNS = 8;
const standardButtons = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Standard icons"] .group-icon-option'));

describe('the icon picker', () => {
    it('is two groups with one Tab stop each, on the chosen icon', async () => {
        const { container, getByRole } = render(<IconPicker defaultIndex={0} icon={5} onChange={() => {}} />);
        expect(getByRole('group', { name: 'Custom icons' })).toBeTruthy();
        const buttons = standardButtons(container);
        expect(buttons.length).toBe(KEEPASS_ICON_COUNT);
        expect(buttons.filter((b) => b.tabIndex === 0).length).toBe(1);
        expect(buttons[5].tabIndex).toBe(0);
        expect(buttons[5].getAttribute('aria-pressed')).toBe('true');
        expect(buttons[0].getAttribute('aria-label')).toBe('Key (default)');
        await expectNoA11yViolations(container);
    });

    it('moves with the arrows, Home and End, and picks on click', () => {
        const onChange = vi.fn();
        const { container } = render(<IconPicker defaultIndex={0} onChange={onChange} />);
        const buttons = standardButtons(container);
        buttons[0].focus();
        fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
        expect(document.activeElement).toBe(buttons[1]);
        expect(buttons[1].tabIndex).toBe(0);
        expect(buttons[0].tabIndex).toBe(-1);
        fireEvent.keyDown(buttons[1], { key: 'ArrowLeft' });
        fireEvent.keyDown(buttons[0], { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(buttons[0]);
        fireEvent.keyDown(buttons[0], { key: 'End' });
        expect(document.activeElement).toBe(buttons[buttons.length - 1]);
        fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Home' });
        expect(document.activeElement).toBe(buttons[0]);
        fireEvent.click(buttons[3]);
        expect(onChange).toHaveBeenCalledWith(3, undefined);
        fireEvent.click(buttons[0]);
        expect(onChange).toHaveBeenCalledWith(undefined, undefined);
    });

    it('moves a row at a time with Up and Down once laid out', () => {
        const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
        Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
            configurable: true,
            get(this: HTMLElement) {
                const siblings = Array.from(this.parentElement?.children ?? []);
                return Math.floor(siblings.indexOf(this) / COLUMNS) * 40;
            },
        });
        try {
            const { container } = render(<IconPicker defaultIndex={0} onChange={() => {}} />);
            const buttons = standardButtons(container);
            buttons[0].focus();
            fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
            expect(document.activeElement).toBe(buttons[COLUMNS]);
            fireEvent.keyDown(buttons[COLUMNS], { key: 'ArrowDown' });
            expect(document.activeElement).toBe(buttons[2 * COLUMNS]);
            fireEvent.keyDown(buttons[2 * COLUMNS], { key: 'ArrowUp' });
            expect(document.activeElement).toBe(buttons[COLUMNS]);
            fireEvent.keyDown(buttons[COLUMNS], { key: 'ArrowUp' });
            fireEvent.keyDown(buttons[0], { key: 'ArrowUp' });
            expect(document.activeElement).toBe(buttons[0]);
        } finally {
            if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
        }
    });

    it('picks a custom icon from its own group', () => {
        const onChange = vi.fn();
        const { container } = render(<IconPicker defaultIndex={0} customIcon="c2" onChange={onChange} />);
        const custom = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Custom icons"] .group-icon-option'));
        expect(custom[1].tabIndex).toBe(0);
        expect(custom[1].getAttribute('aria-pressed')).toBe('true');
        expect(standardButtons(container).some((b) => b.getAttribute('aria-pressed') === 'true')).toBe(false);
        fireEvent.click(custom[0]);
        expect(onChange).toHaveBeenCalledWith(undefined, 'c1');
    });
});

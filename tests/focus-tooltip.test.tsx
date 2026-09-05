// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { FocusTooltip } from '../src/components/FocusTooltip';

// Hover shows a button's title; keyboard focus has to show it too.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const Page = () => (
    <>
        <button title="Lock database">Lock</button>
        <button>Plain</button>
        <FocusTooltip />
    </>
);

const tooltip = () => document.querySelector('.focus-tooltip');

describe('the focus tooltip', () => {
    it('shows the title of a button focused from the keyboard', () => {
        const { getByText } = render(<Page />);
        fireEvent.keyDown(document.body, { key: 'Tab' });
        act(() => getByText('Lock').focus());
        expect(tooltip()?.textContent).toBe('Lock database');
        expect(tooltip()?.getAttribute('aria-hidden')).toBe('true');
        act(() => getByText('Plain').focus());
        expect(tooltip()).toBeNull();
    });

    it('stays hidden after a pointer press and goes on Escape or blur', () => {
        const { getByText } = render(<Page />);
        fireEvent.pointerDown(getByText('Lock'));
        act(() => getByText('Lock').focus());
        expect(tooltip()).toBeNull();
        act(() => getByText('Lock').blur());
        fireEvent.keyDown(document.body, { key: 'Tab' });
        act(() => getByText('Lock').focus());
        expect(tooltip()).not.toBeNull();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(tooltip()).toBeNull();
        act(() => getByText('Lock').focus());
        act(() => getByText('Lock').blur());
        expect(tooltip()).toBeNull();
    });
});

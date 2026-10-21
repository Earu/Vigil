// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { UpdateDialog } from '../src/components/UpdateDialog';
import { expectNoA11yViolations } from './a11y';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    cleanup();
    delete (window as any).electron;
});

const open = () => {
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();
    const view = render(<UpdateDialog version="1.8.1" onUpdate={onUpdate} onDismiss={onDismiss} />);
    return { ...view, onUpdate, onDismiss };
};

describe('update dialog', () => {
    it('names the version and says what staying behind risks', () => {
        const { getByRole } = open();
        const dialog = getByRole('dialog');

        expect(dialog.textContent).toContain('Vigil 1.8.1 is available');
        expect(dialog.textContent).toContain('An old version may leave your vault exposed');
    });

    it('updates only on Update', () => {
        const { getByText, onUpdate, onDismiss } = open();

        fireEvent.click(getByText('Update'));

        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismisses on Not now and on Escape', () => {
        const { getByText, getByRole, onUpdate, onDismiss } = open();

        fireEvent.click(getByText('Not now'));
        fireEvent.keyDown(getByRole('dialog'), { key: 'Escape' });

        expect(onDismiss).toHaveBeenCalledTimes(2);
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('opens the release notes for that version', () => {
        const openExternal = vi.fn(async () => ({ success: true }));
        (window as any).electron = { openExternal };
        const { getByText } = open();

        fireEvent.click(getByText("What's new in 1.8.1"));

        expect(openExternal).toHaveBeenCalledWith('https://github.com/Earu/Vigil/releases/tag/v1.8.1');
    });

    it('has no accessibility violations', async () => {
        const { baseElement } = open();
        await expectNoA11yViolations(baseElement);
    });
});

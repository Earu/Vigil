// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { expectNoA11yViolations } from './a11y';

// React unmounts the whole tree when a render or effect throws with nothing to
// catch it, which here means a blank window, the auto-lock timer gone and the
// main process still holding keys for a vault nobody shows. The boundary keeps
// a window on screen, hands the session back, and never puts the thrown error
// in front of the user: its message can carry whatever the code that threw was
// holding.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const Boom = ({ message = 'kaboom' }: { message?: string }): React.ReactElement => {
    throw new Error(message);
};

const Fine = () => <p>vault</p>;

// The shape the password generator had: a throw from a mount effect rather
// than from render
const BoomOnMount = (): React.ReactElement => {
    React.useEffect(() => { throw new Error('kaboom'); }, []);
    return <p>mounting</p>;
};

function installElectron() {
    const calls = { unsaved: [] as boolean[], vaultClosed: 0 };
    (window as any).electron = {
        setUnsavedChanges: async (dirty: boolean) => { calls.unsaved.push(dirty); },
        reportVaultClosed: async () => { calls.vaultClosed++; },
    };
    return calls;
}

afterEach(() => {
    cleanup();
    delete (window as any).electron;
    vi.restoreAllMocks();
});

const renderCrashed = (message?: string) => {
    // React logs the caught error itself; the boundary's own report is checked
    // through the electron calls rather than through this noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const utils = render(<ErrorBoundary><Boom message={message} /></ErrorBoundary>);
    return { ...utils, spy };
};

describe('error boundary', () => {
    it('renders its children when nothing throws', () => {
        installElectron();
        const { getByText } = render(<ErrorBoundary><Fine /></ErrorBoundary>);
        expect(getByText('vault')).toBeTruthy();
    });

    it('shows a recoverable screen instead of a blank window', () => {
        installElectron();
        const { getByRole, getByText } = renderCrashed();
        expect(getByRole('alert')).toBeTruthy();
        expect(getByText('Reload')).toBeTruthy();
    });

    it('keeps the thrown message off the screen', () => {
        installElectron();
        const secret = 'correct-horse-battery-staple';
        const { container } = renderCrashed(secret);
        expect(container.textContent).not.toContain(secret);
    });

    it('closes the vault session and drops the unsaved-changes guard', () => {
        const calls = installElectron();
        renderCrashed();
        expect(calls.vaultClosed).toBe(1);
        expect(calls.unsaved).toEqual([false]);
    });

    it('catches a throw from a mount effect, not just from render', () => {
        const calls = installElectron();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { getByRole } = render(<ErrorBoundary><BoomOnMount /></ErrorBoundary>);
        expect(getByRole('alert')).toBeTruthy();
        expect(calls.vaultClosed).toBe(1);
        spy.mockRestore();
    });

    it('survives a crash with no electron bridge', () => {
        expect(() => renderCrashed()).not.toThrow();
    });

    it('passes axe', async () => {
        installElectron();
        const { container } = renderCrashed();
        await expectNoA11yViolations(container);
    });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { TpmSetupDialog } from '../src/components/TpmSetupDialog';
import { expectNoA11yViolations } from './a11y';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const PASSWORD = 'k7qm-2xrp-9dht-w4nb';

let step: string | null;
const electron = {
    getTpmSetupStep: vi.fn(async () => step),
    grantTpmAccess: vi.fn(),
    revokeTpmAccess: vi.fn(),
    getTpmLockoutPlan: vi.fn(async (): Promise<any> => ({ success: true, change: null })),
    beginTpmLockout: vi.fn(async (_accept: boolean) => ({ success: true, password: PASSWORD })),
    cancelTpmLockout: vi.fn(async () => {}),
    applyTpmLockout: vi.fn(),
};

beforeEach(() => {
    step = 'lockout';
    for (const fn of Object.values(electron)) fn.mockClear();
    (window as any).electron = electron;
});

const reachConfirm = async () => {
    const view = render(<TpmSetupDialog onClose={() => {}} />);
    fireEvent.click(await view.findByText('Continue'));
    expect(await view.findByText(PASSWORD)).toBeTruthy();
    fireEvent.click(view.getByText('I saved it'));
    return view;
};

describe('the lockout setup', () => {
    it('shows the password, then asks for it typed with pasting blocked', async () => {
        const view = await reachConfirm();
        const input = view.getByLabelText('Recovery password') as HTMLInputElement;
        expect(view.queryByText(PASSWORD)).toBeNull();
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        input.dispatchEvent(paste);
        expect(paste.defaultPrevented).toBe(true);
        expect((view.getByText('Set recovery password') as HTMLButtonElement).disabled).toBe(true);
        await expectNoA11yViolations(view.container);
    });

    it('stays on the confirm step after a mismatch', async () => {
        electron.applyTpmLockout.mockResolvedValueOnce({ success: false, mismatch: true, error: 'This does not match the recovery password' });
        const view = await reachConfirm();
        fireEvent.change(view.getByLabelText('Recovery password'), { target: { value: 'nope' } });
        fireEvent.click(view.getByText('Set recovery password'));
        expect(await view.findByRole('alert')).toBeTruthy();
        expect(electron.applyTpmLockout).toHaveBeenCalledWith('nope');
        expect(view.getByLabelText('Recovery password')).toBeTruthy();
    });

    it('finishes on a match', async () => {
        electron.applyTpmLockout.mockResolvedValueOnce({ success: true });
        const view = await reachConfirm();
        fireEvent.change(view.getByLabelText('Recovery password'), { target: { value: PASSWORD } });
        fireEvent.keyDown(view.getByLabelText('Recovery password'), { key: 'Enter' });
        expect(await view.findByText('Setup complete')).toBeTruthy();
    });

    it('goes straight to the password when the limits stay as they are', async () => {
        await reachConfirm();
        expect(electron.beginTpmLockout).toHaveBeenCalledWith(false);
    });

    it('asks consent for looser limits, naming the old and new values', async () => {
        electron.getTpmLockoutPlan.mockResolvedValueOnce({
            success: true,
            change: { maxTries: { from: 1000, to: 32 }, recoveryInterval: { from: 0, to: 7200 } },
        });
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        fireEvent.click(await view.findByText('Continue'));
        expect(await view.findByText("Change this computer's limits")).toBeTruthy();
        expect(view.getByText('Wrong PINs before guessing is blocked: 1,000 → 32')).toBeTruthy();
        expect(view.getByText(/Time before a wrong PIN is forgiven: off, wrong PINs are not counted → 2 hours/)).toBeTruthy();
        expect(electron.beginTpmLockout).not.toHaveBeenCalled();
        await expectNoA11yViolations(view.container);

        fireEvent.click(view.getByText('Change limits'));
        expect(await view.findByText(PASSWORD)).toBeTruthy();
        expect(electron.beginTpmLockout).toHaveBeenCalledWith(true);
    });

    it('calls a TPM with no real try limit unlimited', async () => {
        electron.getTpmLockoutPlan.mockResolvedValueOnce({ success: true, change: { maxTries: { from: 0xffffffff, to: 32 } } });
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        fireEvent.click(await view.findByText('Continue'));
        expect(await view.findByText('Wrong PINs before guessing is blocked: unlimited → 32')).toBeTruthy();
    });

    it('explains a TPM that allows too few tries, with nothing to do', async () => {
        step = 'too-few-tries';
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        expect(await view.findByText(/fewer than 2 wrong PINs/)).toBeTruthy();
        expect(view.queryByText('Continue')).toBeNull();
    });

    it('gives a command for a recovery password set outside Vigil that keeps it off the command line', async () => {
        step = 'foreign-lockout';
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        await view.findByText(/set outside Vigil/);
        const command = view.container.querySelector('pre')?.textContent ?? '';
        expect(command).toMatch(/^read -rs PASS; printf '%s' "\$PASS" \| tpm2_dictionarylockout .* -p file:-; unset PASS$/);
        expect(command).not.toContain('<password>');
    });

    it('drops the pending password when cancelled', async () => {
        const onClose = vi.fn();
        const view = render(<TpmSetupDialog onClose={onClose} />);
        fireEvent.click(await view.findByText('Continue'));
        await view.findByText(PASSWORD);
        fireEvent.click(view.getByText('Cancel'));
        expect(electron.cancelTpmLockout).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('the access setup', () => {
    beforeEach(() => { step = 'access'; });

    it('moves on to the lockout step once access is granted', async () => {
        electron.grantTpmAccess.mockImplementationOnce(async () => {
            step = 'lockout';
            return { success: true };
        });
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        fireEvent.click(await view.findByText('Continue'));
        expect(await view.findByText('Limit wrong PIN guesses')).toBeTruthy();
    });

    it('shows the commands when Vigil cannot make the change', async () => {
        electron.grantTpmAccess.mockResolvedValueOnce({ success: false, error: 'Run these commands', commands: ['first', 'second'] });
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        fireEvent.click(await view.findByText('Continue'));
        await waitFor(() => expect(view.container.querySelector('pre')?.textContent).toBe('first\nsecond'));
    });

    const leaveAfterGrant = async (onClose = vi.fn()) => {
        electron.grantTpmAccess.mockImplementationOnce(async () => {
            step = 'lockout';
            return { success: true };
        });
        const view = render(<TpmSetupDialog onClose={onClose} />);
        fireEvent.click(await view.findByText('Continue'));
        await view.findByText('Limit wrong PIN guesses');
        fireEvent.click(view.getByText('Cancel'));
        expect(await view.findByText('Remove access for now?')).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
        return view;
    };

    it('offers to remove the access when left before the recovery password is set', async () => {
        const onClose = vi.fn();
        electron.revokeTpmAccess.mockResolvedValueOnce({ success: true });
        const view = await leaveAfterGrant(onClose);
        await expectNoA11yViolations(view.container);
        fireEvent.click(view.getByText('Remove access'));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(electron.revokeTpmAccess).toHaveBeenCalledTimes(1);
    });

    it('closes without removing anything when the access is kept', async () => {
        const onClose = vi.fn();
        const view = await leaveAfterGrant(onClose);
        fireEvent.click(view.getByText('Keep access'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(electron.revokeTpmAccess).not.toHaveBeenCalled();
    });

    it('drops the pending password when left from the password step', async () => {
        electron.grantTpmAccess.mockImplementationOnce(async () => {
            step = 'lockout';
            return { success: true };
        });
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        fireEvent.click(await view.findByText('Continue'));
        fireEvent.click(await view.findByText('Continue'));
        await view.findByText(PASSWORD);
        fireEvent.click(view.getByText('Cancel'));
        expect(await view.findByText('Remove access for now?')).toBeTruthy();
        expect(electron.cancelTpmLockout).toHaveBeenCalledTimes(1);
    });

    it('shows the commands when Vigil cannot remove the access', async () => {
        electron.revokeTpmAccess.mockResolvedValueOnce({ success: false, error: 'Run these commands', commands: ['sudo rm rule'] });
        const view = await leaveAfterGrant();
        fireEvent.click(view.getByText('Remove access'));
        await waitFor(() => expect(view.container.querySelector('pre')?.textContent).toBe('sudo rm rule'));
        expect(view.getByRole('alert').textContent).toBe('Run these commands');
    });

    it('stays put without an error when the removal password prompt is dismissed', async () => {
        electron.revokeTpmAccess.mockResolvedValueOnce({ success: false, cancelled: true, error: 'not given' });
        const view = await leaveAfterGrant();
        fireEvent.click(view.getByText('Remove access'));
        await waitFor(() => expect(electron.revokeTpmAccess).toHaveBeenCalled());
        expect(view.queryByRole('alert')).toBeNull();
        expect(view.getByText('Remove access for now?')).toBeTruthy();
    });

    it('closes straight away when access was there before the dialog opened', async () => {
        step = 'lockout';
        const onClose = vi.fn();
        const view = render(<TpmSetupDialog onClose={onClose} />);
        fireEvent.click(await view.findByText('Cancel'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(view.queryByText('Remove access for now?')).toBeNull();
    });

    it('stays put without an error when the password prompt is dismissed', async () => {
        electron.grantTpmAccess.mockResolvedValueOnce({ success: false, cancelled: true, error: 'not given' });
        const view = render(<TpmSetupDialog onClose={() => {}} />);
        fireEvent.click(await view.findByText('Continue'));
        await waitFor(() => expect(electron.grantTpmAccess).toHaveBeenCalled());
        expect(view.queryByRole('alert')).toBeNull();
        expect(view.getByText('Set up PIN unlock')).toBeTruthy();
    });
});

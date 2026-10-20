// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { YubiKeyPanel } from '../src/components/PasswordView/YubiKeyPanel';
import { OathAccount } from '../src/types/electron';
import { expectNoA11yViolations } from './a11y';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const account = (id: string, name: string, issuer: string | null, overrides: Partial<OathAccount> = {}): OathAccount => ({
    id, name, issuer, type: 'TOTP', period: 30, code: null, requiresTouch: true, ...overrides,
});

let accounts: OathAccount[];
let copied: string[];
let calculated: string[];

beforeEach(() => {
    accounts = [
        account('GitHub:octo', 'octo', 'GitHub'),
        account('RSI:Techbot121', 'Techbot121', 'Roberts Space Industries'),
        account('Mail:me', 'me@example.com', 'Mail', { requiresTouch: false, code: '123456' }),
    ];
    copied = [];
    calculated = [];
    (window as any).electron = {
        getPlatform: async () => 'linux',
        yubikeyOathAccounts: vi.fn(async () => ({ ok: true, value: accounts })),
        yubikeyOathCode: vi.fn(async (_serial: unknown, id: string) => {
            calculated.push(id);
            return { ok: true, value: id === 'GitHub:octo' ? '111222' : '333444' };
        }),
        copySecret: vi.fn(async (text: string) => { copied.push(text); return { success: true }; }),
    };
    (window as any).showToast = () => {};
});

afterEach(() => {
    cleanup();
    delete (window as any).electron;
});

const open = async (onClose = () => {}) => {
    const view = render(<YubiKeyPanel onClose={onClose} />);
    await waitFor(() => expect(view.getByLabelText('Search accounts')).toBeTruthy());
    return { ...view, search: view.getByLabelText('Search accounts') as HTMLInputElement };
};

const rowOf = (el: HTMLElement) => el.closest('.yubikey-row') as HTMLElement;

describe('YubiKey panel search', () => {
    it('focuses the search and filters by name and issuer', async () => {
        const { search, queryByText } = await open();
        expect(document.activeElement).toBe(search);

        fireEvent.change(search, { target: { value: 'rob' } });
        expect(queryByText('Techbot121')).toBeTruthy();
        expect(queryByText('octo')).toBeNull();

        fireEvent.change(search, { target: { value: 'OCTO' } });
        expect(queryByText('octo')).toBeTruthy();
        expect(queryByText('Techbot121')).toBeNull();

        fireEvent.change(search, { target: { value: 'nothing' } });
        expect(queryByText('No account matches.')).toBeTruthy();
    });

    it('runs the first match on Enter, and the selected one after the arrows move', async () => {
        const { search } = await open();

        fireEvent.change(search, { target: { value: 'rob' } });
        await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }); });
        await waitFor(() => expect(copied).toEqual(['333444']));
        expect(calculated).toEqual(['RSI:Techbot121']);

        fireEvent.change(search, { target: { value: '' } });
        fireEvent.keyDown(search, { key: 'ArrowDown' });
        fireEvent.keyDown(search, { key: 'ArrowDown' });
        fireEvent.keyDown(search, { key: 'ArrowDown' });
        await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }); });
        await waitFor(() => expect(copied).toEqual(['333444', '123456']));
        expect(calculated).toEqual(['RSI:Techbot121']);
    });

    it('clears the search on the first Escape and closes on the second', async () => {
        const onClose = vi.fn();
        const { search } = await open(onClose);

        fireEvent.change(search, { target: { value: 'rob' } });
        fireEvent.keyDown(search, { key: 'Escape' });
        expect(search.value).toBe('');
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(search, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('has no accessibility violations', async () => {
        const { baseElement } = await open();
        await expectNoA11yViolations(baseElement);
    });
});

describe('YubiKey panel header and warnings', () => {
    it('puts the note behind an info button next to the title', async () => {
        const { getByLabelText, queryByText } = await open();

        const info = getByLabelText('About these accounts');
        expect(info.getAttribute('title')).toBe('These accounts live on the key. Vigil shows their codes and nothing more.');
        expect(info.previousElementSibling?.textContent).toBe('YubiKey');
        expect(queryByText('These accounts live on the key. Vigil shows their codes and nothing more.')).toBeNull();
    });

    it('shows a failed calculation as a warning', async () => {
        (window as any).electron.yubikeyOathCode = vi.fn(async () => ({ ok: false, error: 'timeout' }));
        const { getByText, baseElement } = await open();

        await act(async () => { fireEvent.doubleClick(rowOf(getByText('octo'))); });

        const heading = await waitFor(() => getByText('The key did not answer in time'));
        expect(heading.tagName).toBe('H3');
        expect(heading.closest('.weak-password-warning-header')).toBeTruthy();
        expect(copied).toEqual([]);
        await expectNoA11yViolations(baseElement);
    });
});

describe('YubiKey panel details', () => {
    const details = (getByLabelText: (text: string) => HTMLElement) => getByLabelText('Account details');

    it('shows a hint until an account is selected, then its details', async () => {
        const { getByText, getByLabelText } = await open();
        expect(details(getByLabelText).textContent).toContain('Select an account to see its details.');

        fireEvent.click(rowOf(getByText('Roberts Space Industries')));

        const panel = details(getByLabelText);
        expect(panel.querySelector('h2')!.textContent).toBe('Roberts Space Industries');
        expect((panel.querySelector('#yubikey-detail-account') as HTMLInputElement).value).toBe('Techbot121');
        expect(panel.textContent).toContain('Required for every code');
        expect(panel.textContent).toContain('Touch the key to see a code');
    });

    it('generates from the sidebar and shows the code with its countdown', async () => {
        const { getByText, getByLabelText } = await open();
        fireEvent.click(rowOf(getByText('GitHub')));
        const panel = details(getByLabelText);

        await act(async () => {
            fireEvent.click(panel.querySelector('.generate-button') as HTMLElement);
        });

        await waitFor(() => expect(panel.querySelector('.totp-code')?.textContent).toContain('111'));
        expect(calculated).toEqual(['GitHub:octo']);
        expect(copied).toEqual([]);
        expect(panel.querySelector('[role=timer]')).toBeTruthy();
    });

    it('keeps the selection while the search narrows around it', async () => {
        const { getByText, getByLabelText, search } = await open();
        fireEvent.click(rowOf(getByText('GitHub')));

        fireEvent.change(search, { target: { value: 'oct' } });

        expect(details(getByLabelText).querySelector('h2')!.textContent).toBe('GitHub');
    });

    it('has no accessibility violations with an account selected', async () => {
        const { getByText, baseElement } = await open();
        fireEvent.click(rowOf(getByText('me@example.com')));
        await expectNoA11yViolations(baseElement);
    });
});

describe('YubiKey panel rows', () => {
    it('leads with the issuer and puts the account name under it', async () => {
        accounts = [account('Google:me', 'me@example.com', 'Google'), account('bare', 'bare-account', null)];
        const { getByText } = await open();

        const row = rowOf(getByText('Google'));
        expect(row.querySelector('.yubikey-row-title')!.textContent).toBe('Google');
        expect(row.querySelector('.yubikey-row-subtitle')!.textContent).toBe('me@example.com');

        const bare = rowOf(getByText('bare-account'));
        expect(bare.querySelector('.yubikey-row-title')!.textContent).toBe('bare-account');
        expect(bare.querySelector('.yubikey-row-subtitle')).toBeNull();
    });

    it('selects on click and does nothing else', async () => {
        const { getByText } = await open();
        const row = rowOf(getByText('octo'));

        fireEvent.click(row);

        expect(row.classList.contains('selected')).toBe(true);
        expect(calculated).toEqual([]);
        expect(copied).toEqual([]);
    });

    it('generates and copies a code on double-click when the key holds it back', async () => {
        const { getByText } = await open();
        const row = rowOf(getByText('octo'));

        await act(async () => { fireEvent.doubleClick(row); });

        await waitFor(() => expect(copied).toEqual(['111222']));
        expect(calculated).toEqual(['GitHub:octo']);
        expect(document.querySelector('[aria-label="Account details"] .totp-code')!.textContent).toContain('111');
    });

    it('shows only the account labels, no code, timer or buttons', async () => {
        const { getByText } = await open();
        const row = rowOf(getByText('me@example.com'));

        expect(row.querySelectorAll('button')).toHaveLength(0);
        expect(row.querySelector('[role=timer]')).toBeNull();
        expect(row.textContent).not.toContain('123');
    });

    it('copies the code already on screen without asking the key again', async () => {
        const { getByText } = await open();

        await act(async () => { fireEvent.doubleClick(rowOf(getByText('me@example.com'))); });

        await waitFor(() => expect(copied).toEqual(['123456']));
        expect(calculated).toEqual([]);
    });
});

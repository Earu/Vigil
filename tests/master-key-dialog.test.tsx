// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import * as kdbxweb from 'kdbxweb';
import { MasterKeyDialog } from '../src/components/MasterKeyDialog';
import { PendingCredentialChange } from '../src/services/KeepassDatabaseService';
import { expectNoA11yViolations } from './a11y';

// The dialog changes the whole master key at once, and the parts of it the
// user did not touch must stay out of the change: a vault behind a key file
// whose owner only rotates the password must not come back password-only.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const KEYFILE = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

beforeEach(() => {
    (globalThis as any).window.electron = {
        isHardwareKeyPresent: async () => false,
        selectKeyFile: async () => ({ filePath: '/keys/vault.keyx' }),
        readFile: async () => ({ success: true, data: KEYFILE }),
        hasBiometricsEnabled: async () => ({ success: true, enabled: false }),
        getBackupInfo: async () => ({ count: 0, totalBytes: 0, newest: null }),
    };
});

afterEach(() => {
    cleanup();
    delete (globalThis as any).window.electron;
    vi.useRealTimers();
});

const makeVault = async (withKeyFile = false, version: 3 | 4 = 4) => {
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));
    // The password hash lands asynchronously, and the dialog checks it
    await credentials.ready;
    if (withKeyFile) await credentials.setKeyFile(KEYFILE.slice().buffer);
    const db = kdbxweb.Kdbx.create(credentials, 'Vault');
    db.setVersion(version);
    return db;
};

const show = async (db: kdbxweb.Kdbx, onSave: (c: PendingCredentialChange) => Promise<boolean>) =>
    render(<MasterKeyDialog kdbxDb={db} onSave={onSave} onClose={() => {}} />);

const fill = (view: ReturnType<typeof render>, current: string, next: string, confirm = next) => {
    const [currentPw, newPw, confirmPw] = Array.from(
        view.container.querySelectorAll<HTMLInputElement>('input[type=password]')
    );
    fireEvent.change(currentPw, { target: { value: current } });
    fireEvent.change(newPw, { target: { value: next } });
    fireEvent.change(confirmPw, { target: { value: confirm } });
};

const apply = (view: ReturnType<typeof render>) =>
    fireEvent.click(view.getByRole('button', { name: 'Change master key' }));

describe('the master key dialog', () => {
    it('has no accessibility violations', async () => {
        const view = await show(await makeVault(), async () => true);
        await expectNoA11yViolations(view.container);
    });

    it('refuses a wrong current password without touching the vault', async () => {
        const onSave = vi.fn(async () => true);
        const view = await show(await makeVault(), onSave);

        fill(view, 'wrong', 'rotated');
        apply(view);

        await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(/current password is incorrect/));
        expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses a confirmation that does not match', async () => {
        const onSave = vi.fn(async () => true);
        const view = await show(await makeVault(), onSave);

        fill(view, 'test', 'rotated', 'rotatd');
        apply(view);

        await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(/do not match/));
        expect(onSave).not.toHaveBeenCalled();
    });

    it('leaves an untouched key file out of the change, so the save keeps it', async () => {
        const onSave = vi.fn(async () => true);
        const view = await show(await makeVault(true), onSave);

        fill(view, 'test', 'rotated');
        apply(view);

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const change = onSave.mock.calls[0][0] as PendingCredentialChange;
        expect(change.password).toBeTruthy();
        // Absence is what keeps it; null would remove it
        expect('keyFile' in change).toBe(false);
    });

    it('removes the key file when it is cleared', async () => {
        const onSave = vi.fn(async () => true);
        const view = await show(await makeVault(true), onSave);

        fireEvent.click(view.getByLabelText('Remove key file'));
        fill(view, 'test', 'rotated');
        apply(view);

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        expect((onSave.mock.calls[0][0] as PendingCredentialChange).keyFile).toBeNull();
    });

    it('carries a newly chosen key file with the password', async () => {
        const onSave = vi.fn(async () => true);
        const view = await show(await makeVault(), onSave);

        fireEvent.click(view.getByText('Key file (optional)'));
        await waitFor(() => expect(view.getByLabelText('Remove key file')).toBeTruthy());
        fill(view, 'test', 'rotated');
        apply(view);

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const change = onSave.mock.calls[0][0] as PendingCredentialChange;
        expect(new Uint8Array(change.keyFile as ArrayBuffer)).toEqual(KEYFILE);
    });

    // kdbx3 mixes the challenge response into the master key too (kdbxweb
    // challenges with the master seed there, with the KDF salt in kdbx4), so
    // the format is no reason to withhold the option
    it('offers the hardware key on an old-format vault as well', async () => {
        (globalThis as any).window.electron.isHardwareKeyPresent = async () => true;
        const view = await show(await makeVault(false, 3), async () => true);

        await waitFor(() => expect(view.getByText('Hardware key (optional)')).toBeTruthy());
    });

    it('stays open on a save that failed, so nothing has to be typed again', async () => {
        const onSave = vi.fn(async () => false);
        const onClose = vi.fn();
        const db = await makeVault();
        const view = render(<MasterKeyDialog kdbxDb={db} onSave={onSave} onClose={onClose} />);

        fill(view, 'test', 'rotated');
        apply(view);

        await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(/was not changed/));
        expect(onClose).not.toHaveBeenCalled();
    });
});

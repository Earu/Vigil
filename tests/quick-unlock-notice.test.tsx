// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { PasswordForm } from '../src/components/Authentication/PasswordForm';
import { userSettingsService } from '../src/services/UserSettingsService';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const NOTICE = 'PIN unlock needs a one-time setup on this computer';
const electron = new Proxy({
    getBiometricsInfo: async () => ({ available: false, backend: 'none', biometryType: 'pin', methods: [], unavailableReason: NOTICE }),
    getTpmSetupStep: async () => 'access',
    hasBiometricsEnabled: async () => ({ success: true, enabled: false }),
    listHardwareKeys: async () => [],
}, { get: (target, key) => (target as any)[key] ?? (async () => null) });

beforeEach(() => {
    (window as any).electron = electron;
    vi.spyOn(userSettingsService, 'getQuickUnlockNoticeDismissed').mockReturnValue(false);
    vi.spyOn(userSettingsService, 'setQuickUnlockNoticeDismissed').mockImplementation(() => {});
});

const renderForm = () => render(
    <PasswordForm
        selectedFile={new File([], 'vault.kdbx')}
        isCreatingNew={false}
        databasePath="/home/someone/vault.kdbx"
        error={null}
        setError={() => {}}
        setSelectedFile={() => {}}
        onDatabaseOpen={() => {}}
        onBreachCheckComplete={() => {}}
        passwordInputRef={React.createRef()}
        setIsCreatingNew={() => {}}
        initialBiometricsEnabled={false}
    />
);

describe('the quick unlock notice', () => {
    it('offers the setup and can be hidden for good', async () => {
        const view = renderForm();
        expect(await view.findByText(NOTICE, { exact: false })).toBeTruthy();
        expect(view.getByText('Set up')).toBeTruthy();

        fireEvent.click(view.getByLabelText('Hide this message'));
        expect(view.queryByText(NOTICE, { exact: false })).toBeNull();
        expect(userSettingsService.setQuickUnlockNoticeDismissed).toHaveBeenCalledWith(true);
    });

    it('stays hidden once dismissed', async () => {
        vi.mocked(userSettingsService.getQuickUnlockNoticeDismissed).mockReturnValue(true);
        const view = renderForm();
        await view.findByPlaceholderText('Enter password');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(view.queryByText(NOTICE, { exact: false })).toBeNull();
    });
});

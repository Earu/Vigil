// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { PasswordForm } from '../src/components/Authentication/PasswordForm';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const EASY = 'This PIN is among the first ones an attacker would try. Choose another';

const calls = { readFile: vi.fn(async () => null) };
const electron = new Proxy({
    getBiometricsInfo: async () => ({
        available: true, backend: 'hardware', biometryType: 'pin', methods: ['pin'], pinMinLength: 6, pinGuessesPerYear: 31 + 52560,
    }),
    hasBiometricsEnabled: async () => ({ success: true, enabled: false }),
    listHardwareKeys: async () => [],
    readFile: calls.readFile,
}, { get: (target, key) => (target as any)[key] ?? (async () => null) });

beforeEach(() => {
    calls.readFile.mockClear();
    (window as any).electron = electron;
});

const choosePin = async (pin: string) => {
    const view = render(
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
    fireEvent.click(await view.findByRole('button', { name: 'PIN' }));
    fireEvent.change(view.getByPlaceholderText('Enter password'), { target: { value: 'hunter2' } });
    fireEvent.change(view.getByLabelText('Choose a PIN'), { target: { value: pin } });
    fireEvent.change(view.getByLabelText('Confirm PIN'), { target: { value: pin } });
    return view;
};

describe('choosing a PIN', () => {
    it('refuses one an attacker would guess within a year on this computer', async () => {
        const view = await choosePin('250990');
        expect(await view.findByText(EASY)).toBeTruthy();
        expect((view.getByRole('button', { name: /Turn on PIN/ }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.keyDown(view.getByLabelText('Confirm PIN'), { key: 'Enter' });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(calls.readFile).not.toHaveBeenCalled();
    });

    it('takes a random one', async () => {
        const view = await choosePin('482915');
        fireEvent.click(view.getByRole('button', { name: /Turn on PIN/ }));
        await waitFor(() => expect(calls.readFile).toHaveBeenCalled());
        expect(view.queryByText(EASY)).toBeNull();
    });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TitleBar } from '../src/components/TitleBar';
import { PasswordGenerator } from '../src/components/PasswordView/PasswordGenerator';
import { PasskeyConsentDialog } from '../src/components/PasskeyConsentDialog';
import { SetLoginConsentDialog } from '../src/components/SetLoginConsentDialog';
import { AccessConsentDialog } from '../src/components/AccessConsentDialog';
import { SaveConflictDialog } from '../src/components/SaveConflictDialog';
import { HardwareKeyTouchDialog } from '../src/components/HardwareKeyTouchDialog';
import { BrowserPairingDialog } from '../src/components/BrowserPairingDialog';
import { DatabaseForm } from '../src/components/Authentication/DatabaseForm';
import { expectNoA11yViolations } from './a11y';

// Icon-only controls carry names, dialogs are labelled, and axe finds
// nothing to complain about in the screens that are cheap to render alone.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const noop = () => {};

describe('the title bar', () => {
    it('names the window controls and the search box', async () => {
        const { getByRole, getByLabelText, container } = render(<TitleBar inPasswordView onLock={noop} onOpenSettings={noop} onOpenSecurityReport={noop} />);
        expect(getByRole('button', { name: 'Minimize' })).toBeTruthy();
        expect(getByRole('button', { name: 'Maximize' })).toBeTruthy();
        expect(getByRole('button', { name: 'Close window' })).toBeTruthy();
        expect(getByRole('button', { name: 'Settings' })).toBeTruthy();
        expect(getByRole('button', { name: 'Security report' })).toBeTruthy();
        expect(getByLabelText('Search passwords')).toBeTruthy();
        await expectNoA11yViolations(container);
    });
});

describe('the password generator', () => {
    it('is a labelled dialog with tabs and named controls', async () => {
        const { getByRole, getByLabelText, container } = render(<PasswordGenerator onClose={noop} onSave={noop} />);
        expect(getByRole('dialog', { name: 'Generate New Password' })).toBeTruthy();
        expect(getByRole('tablist', { name: 'Password type' })).toBeTruthy();
        expect(getByRole('button', { name: 'Copy password' })).toBeTruthy();
        expect(getByRole('button', { name: 'Close password generator' })).toBeTruthy();
        expect(getByLabelText('Password Length')).toBeTruthy();
        expect(getByLabelText('Generated password')).toBeTruthy();
        await expectNoA11yViolations(container);
        fireEvent.click(getByRole('tab', { name: 'Passphrase' }));
        expect(getByLabelText('Number of Words')).toBeTruthy();
        await expectNoA11yViolations(container);
    });
});

describe('the consent dialogs', () => {
    it('passkey: labelled, with the choices as radios', async () => {
        const request = { kind: 'get' as const, rpId: 'example.com', origin: 'https://example.com', entries: [
            { title: 'Example', username: 'me', credentialId: 'c1' },
            { title: 'Other', username: 'you', credentialId: 'c2' },
        ] };
        const { getByRole, getAllByRole, container } = render(<PasskeyConsentDialog request={request} onSubmit={noop} onCancel={noop} />);
        expect(getByRole('dialog', { name: 'Use Passkey' })).toBeTruthy();
        expect(getAllByRole('radio').length).toBe(2);
        expect(document.activeElement).toBe(getAllByRole('radio')[0]);
        await expectNoA11yViolations(container);
    });

    it('save login: labelled, Deny focused', async () => {
        const request = { url: 'https://example.com', login: 'me', mode: 'create' as const };
        const { getByRole, container } = render(<SetLoginConsentDialog request={request} onSubmit={noop} onCancel={noop} />);
        expect(getByRole('dialog', { name: 'Save Login' })).toBeTruthy();
        expect(document.activeElement).toBe(getByRole('button', { name: 'Deny' }));
        // Opened by a browser request, not a key press: no ring until one
        expect(getByRole('dialog').hasAttribute('data-quiet-focus')).toBe(true);
        await expectNoA11yViolations(container);
    });

    it('access: labelled, with the entries as checkboxes', async () => {
        const request = { url: 'https://example.com', host: 'example.com', entries: [{ id: 'e1', title: 'Example', username: 'me' }] };
        const { getByRole, getAllByRole, container } = render(<AccessConsentDialog request={request} onSubmit={noop} onCancel={noop} />);
        expect(getByRole('dialog', { name: 'Allow Browser Access' })).toBeTruthy();
        expect(getAllByRole('checkbox').length).toBe(2);
        await expectNoA11yViolations(container);
    });

    it('save conflict: an alert dialog described by its message', async () => {
        const { getByRole, container } = render(<SaveConflictDialog message="Disk copy is newer." onOverwrite={noop} onCancel={noop} />);
        const dialog = getByRole('alertdialog', { name: 'Database Changed on Disk' });
        expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
        await expectNoA11yViolations(container);
    });

    it('hardware key touch: labelled, holds focus, ignores Escape', async () => {
        const { getByRole, container } = render(<HardwareKeyTouchDialog />);
        const dialog = getByRole('dialog', { name: 'Touch your hardware key' });
        expect(document.activeElement).toBe(dialog);
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(getByRole('dialog')).toBeTruthy();
        await expectNoA11yViolations(container);
    });

    it('browser pairing: labelled, name field focused and named', async () => {
        const { getByRole, getByLabelText, container } = render(<BrowserPairingDialog fingerprint="abcd" existingNames={[]} onSubmit={noop} onCancel={noop} />);
        expect(getByRole('dialog', { name: 'Browser Connection Request' })).toBeTruthy();
        expect(document.activeElement).toBe(getByLabelText('Connection name'));
        await expectNoA11yViolations(container);
    });
});

describe('the unlock screen import dialog', () => {
    it('is a labelled dialog that Escape closes, returning focus', async () => {
        const { getByText, getByRole, queryByRole, container } = render(
            <DatabaseForm setSelectedFile={noop} setDatabasePath={noop} setIsCreatingNew={noop} setError={noop} setBrowserPasswords={noop} />
        );
        const opener = getByText('Import passwords');
        opener.focus();
        fireEvent.click(opener);
        expect(getByRole('dialog', { name: 'Import Passwords' })).toBeTruthy();
        await expectNoA11yViolations(container);
        fireEvent.keyDown(getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
        expect(queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });
});

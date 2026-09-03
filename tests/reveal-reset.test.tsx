// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { EntryDetails } from '../src/components/PasswordView/EntryDetails';
import { Entry } from '../src/types/database';

// A reveal belongs to the entry it was clicked on. The details panel is not
// remounted when the selection changes, so without an explicit reset the
// next entry's password renders in plaintext with no reveal click.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeEntry(id: string, title: string, password: string): Entry {
    return {
        id, title, username: 'user', password,
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
    };
}

const a = makeEntry('id-a', 'Alpha', 'secret-a');
const b = makeEntry('id-b', 'Beta', 'secret-b');

afterEach(cleanup);

describe('password reveal on entry switch', () => {
    it('hides the password again when a different entry is selected', () => {
        const { getByPlaceholderText, getByTitle, rerender } = render(
            <EntryDetails entry={a} onClose={() => {}} onSave={async () => {}} />
        );
        const passwordInput = () => getByPlaceholderText('Enter password') as HTMLInputElement;
        expect(passwordInput().type).toBe('password');

        fireEvent.click(getByTitle('Show password'));
        expect(passwordInput().type).toBe('text');

        rerender(<EntryDetails entry={b} onClose={() => {}} onSave={async () => {}} />);
        expect(passwordInput().type).toBe('password');
        expect(passwordInput().value).toBe('secret-b');
    });
});

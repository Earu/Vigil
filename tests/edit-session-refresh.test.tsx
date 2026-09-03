// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { EntryDetails } from '../src/components/PasswordView/EntryDetails';
import { Entry } from '../src/types/database';

// The details panel receives a fresh entry object whenever the model is
// rebuilt, which happens on every save, including ones the user did not
// start: a browser extension's set-login lands mid-edit. That refresh must
// not re-seed the form and silently discard what the user has typed. A
// selection change to a different entry still resets everything.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeEntry(id: string, title: string, overrides: Partial<Entry> = {}): Entry {
    return {
        id, title, username: 'user', password: 'pw',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
        ...overrides,
    };
}

afterEach(cleanup);

const renderDetails = (entry: Entry) =>
    render(<EntryDetails entry={entry} onClose={() => {}} onSave={async () => {}} />);

describe('a model refresh while an edit session is open', () => {
    it('keeps the typed values and stays in edit mode', () => {
        const a = makeEntry('id-a', 'Alpha');
        const { getByTitle, getByPlaceholderText, getByText, rerender } = renderDetails(a);

        fireEvent.click(getByTitle('Edit entry'));
        const titleInput = () => getByPlaceholderText('Enter title') as HTMLInputElement;
        fireEvent.change(titleInput(), { target: { value: 'Alpha renamed' } });

        // A background save rebuilt the model: same entry id, new object,
        // even new content (the browser wrote a password)
        rerender(
            <EntryDetails
                entry={makeEntry('id-a', 'Alpha', { password: 'browser-saved' })}
                onClose={() => {}}
                onSave={async () => {}}
            />
        );

        expect(titleInput().value).toBe('Alpha renamed');
        expect(getByText('Save')).toBeTruthy();
    });

    it('still re-seeds a same-entry refresh when not editing', () => {
        const a = makeEntry('id-a', 'Alpha');
        const { getByPlaceholderText, rerender } = renderDetails(a);

        rerender(
            <EntryDetails
                entry={makeEntry('id-a', 'Alpha updated')}
                onClose={() => {}}
                onSave={async () => {}}
            />
        );

        expect((getByPlaceholderText('Enter title') as HTMLInputElement).value).toBe('Alpha updated');
    });

    it('still resets the form when a different entry is selected mid-edit', () => {
        const a = makeEntry('id-a', 'Alpha');
        const { getByTitle, getByPlaceholderText, queryByText, rerender } = renderDetails(a);

        fireEvent.click(getByTitle('Edit entry'));
        fireEvent.change(getByPlaceholderText('Enter title'), { target: { value: 'Alpha renamed' } });

        rerender(
            <EntryDetails entry={makeEntry('id-b', 'Beta')} onClose={() => {}} onSave={async () => {}} />
        );

        expect((getByPlaceholderText('Enter title') as HTMLInputElement).value).toBe('Beta');
        // Back in view mode: no save button
        expect(queryByText('Save')).toBeNull();
    });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import * as kdbxweb from 'kdbxweb';
import { ReferenceWizard } from '../src/components/PasswordView/ReferenceWizard';
import { PlaceholderService, uuidBase64ToHex } from '../src/services/PlaceholderService';
import { Entry, Group } from '../src/types/database';
import { expectNoA11yViolations } from './a11y';

// The reference wizard: lists the vault's entries, filters on search,
// excludes the entry being edited, and inserts a UUID-form {REF:...} token
// for the chosen entry and field.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeEntry(id: string, title: string, username = ''): Entry {
    return {
        id, title, username, password: 'p',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
    };
}

const a = makeEntry(kdbxweb.KdbxUuid.random().toString(), 'Aardvark', 'alice');
const b = makeEntry(kdbxweb.KdbxUuid.random().toString(), 'Bison', 'bob');
const me = makeEntry(kdbxweb.KdbxUuid.random().toString(), 'Myself');
const root: Group = { id: 'root', name: 'Root', groups: [], entries: [a, b, me] };

afterEach(() => {
    cleanup();
    PlaceholderService.setModelRoot(null);
});

describe('ReferenceWizard', () => {
    it('is a dialog with the search focused, and Escape closes it', async () => {
        PlaceholderService.setModelRoot(root);
        const onClose = vi.fn();
        const { container, getByPlaceholderText } = render(
            <ReferenceWizard defaultField="P" excludeEntryId={me.id} onInsert={() => {}} onClose={onClose} />
        );
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        expect(document.activeElement).toBe(getByPlaceholderText('Search entries'));
        await expectNoA11yViolations(container);
        fireEvent.keyDown(getByPlaceholderText('Search entries'), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('lists entries, filters, excludes the edited entry, and inserts a UUID token', () => {
        PlaceholderService.setModelRoot(root);
        const onInsert = vi.fn();
        const onClose = vi.fn();
        const { getByText, queryByText, getByPlaceholderText, container } = render(
            <ReferenceWizard defaultField="P" excludeEntryId={me.id} onInsert={onInsert} onClose={onClose} />
        );

        expect(getByText('Aardvark')).toBeTruthy();
        expect(getByText('Bison')).toBeTruthy();
        expect(queryByText('Myself')).toBeNull();

        fireEvent.change(getByPlaceholderText('Search entries'), { target: { value: 'bison' } });
        expect(queryByText('Aardvark')).toBeNull();

        fireEvent.click(getByText('Bison'));
        // The destination field preselects the source field
        expect((container.querySelector('select') as HTMLSelectElement).value).toBe('P');
        fireEvent.click(getByText('Insert'));

        expect(onInsert).toHaveBeenCalledWith(`{REF:P@I:${uuidBase64ToHex(b.id).toUpperCase()}}`);
        expect(onClose).toHaveBeenCalled();
    });

    it('disables Insert until an entry is chosen and honours the field choice', () => {
        PlaceholderService.setModelRoot(root);
        const onInsert = vi.fn();
        const { getByText, container } = render(
            <ReferenceWizard defaultField="U" onInsert={onInsert} onClose={vi.fn()} />
        );
        expect((getByText('Insert') as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(getByText('Aardvark'));
        fireEvent.change(container.querySelector('select')!, { target: { value: 'A' } });
        fireEvent.click(getByText('Insert'));
        expect(onInsert.mock.calls[0][0]).toBe(`{REF:A@I:${uuidBase64ToHex(a.id).toUpperCase()}}`);
    });
});

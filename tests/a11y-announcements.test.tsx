// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { EntryList } from '../src/components/PasswordView/EntryList';
import { EntryDetails } from '../src/components/PasswordView/EntryDetails';
import { Database, Entry, Group } from '../src/types/database';

// What a screen reader hears without moving: the result count as a search
// narrows, and the state of the toggles that fold content away.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
afterEach(cleanup);

function makeEntry(id: string, title: string, over: Partial<Entry> = {}): Entry {
    return {
        id, title, username: 'u', password: 'p',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [], ...over,
    };
}

describe('the entry count', () => {
    it('is a live region that reads the search result count', () => {
        const root: Group = { id: 'root', name: 'Root', groups: [], entries: [makeEntry('a', 'alpha'), makeEntry('b', 'beta')] };
        const database: Database = { name: 'db', groups: [], root };
        const { container, rerender } = render(
            <EntryList group={root} searchQuery="" selectedEntry={null} onEntrySelect={() => {}} database={database} onNewEntry={() => {}} onRemoveEntry={() => {}} />
        );
        const count = container.querySelector('.entry-count')!;
        expect(count.getAttribute('aria-live')).toBe('polite');
        expect(count.textContent).toBe('2 entries');
        rerender(
            <EntryList group={root} searchQuery="alp" selectedEntry={null} onEntrySelect={() => {}} database={database} onNewEntry={() => {}} onRemoveEntry={() => {}} />
        );
        expect(count.textContent).toBe('1 found');
    });
});

describe('collapsible toggles', () => {
    it('expose history rows as expanded or collapsed', () => {
        const version = { title: 'old', username: 'old-user', password: 'old-pw', modified: new Date(), attachments: [], customFields: [], tags: [] } as any;
        const { getAllByRole } = render(
            <EntryDetails entry={makeEntry('a', 'alpha', { history: [version] })} onClose={() => {}} onSave={() => {}} />
        );
        const row = getAllByRole('button').find((b) => b.classList.contains('history-row'))!;
        expect(row.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(row);
        expect(row.getAttribute('aria-expanded')).toBe('true');
    });

    it('expose the icon picker toggle', () => {
        const { getByTitle, getByText } = render(
            <EntryDetails entry={makeEntry('a', 'alpha')} onClose={() => {}} onSave={() => {}} />
        );
        fireEvent.click(getByTitle('Edit entry'));
        const toggle = getByText('Change...');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });
});

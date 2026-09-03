// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { EntryList } from '../src/components/PasswordView/EntryList';
import { Database, Entry, Group } from '../src/types/database';

// A search scoped to a subgroup shows a footer with a jump to a global
// search; a root-scoped search and a plain group view show none.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the list only uses it to track viewport height
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

function makeEntry(id: string, title: string): Entry {
    return {
        id, title, username: 'u', password: 'p',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
    };
}

function makeModel(): { database: Database; sub: Group } {
    const sub: Group = { id: 'sub', name: 'Work', groups: [], entries: [makeEntry('e1', 'alpha')] };
    const root: Group = { id: 'root', name: 'Root', groups: [sub], entries: [makeEntry('e2', 'beta')] };
    const database: Database = { name: 'db', groups: root.groups, root };
    return { database, sub };
}

const noop = () => {};

function renderList(group: Group, database: Database, searchQuery: string, onSearchEverywhere?: () => void) {
    return render(
        <EntryList
            group={group}
            searchQuery={searchQuery}
            selectedEntry={null}
            onEntrySelect={noop}
            database={database}
            onNewEntry={noop}
            onRemoveEntry={noop}
            onSearchEverywhere={onSearchEverywhere}
        />
    );
}

afterEach(cleanup);

describe('search scope note', () => {
    it('shows the note and widens the search on click', () => {
        const { database, sub } = makeModel();
        const widen = vi.fn();
        const { getByText } = renderList(sub, database, 'alpha', widen);

        fireEvent.click(getByText('Search entire database'));
        expect(widen).toHaveBeenCalledTimes(1);
    });

    it('shows nothing without a search query', () => {
        const { database, sub } = makeModel();
        const { container } = renderList(sub, database, '', vi.fn());
        expect(container.querySelector('.search-scope-note')).toBeNull();
    });

    it('shows nothing when the search is already global', () => {
        const { database } = makeModel();
        const { container } = renderList(database.root, database, 'beta', undefined);
        expect(container.querySelector('.search-scope-note')).toBeNull();
    });
});

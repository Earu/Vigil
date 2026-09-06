// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { Database, Entry, Group } from '../src/types/database';

// Every route out of an open edit form asks before discarding it, except the
// search query, which is not a handler in this view at all: it arrives as a
// prop that has already changed. Clearing the selection on it unmounted the
// details panel, and the panel reports itself clean on unmount, so the typed
// values and the flag guarding the window close both went at once. A dirty
// form stays put instead; every other route keeps its prompt.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const confirmSpy = vi.fn(async () => true);
vi.mock('../src/services/Dialogs', () => ({
    confirmDialog: (...args: any[]) => confirmSpy(...(args as [])),
    alertDialog: async () => {},
    promptDialog: async () => null,
}));

import { PasswordView } from '../src/components/PasswordView';

afterEach(() => { cleanup(); confirmSpy.mockClear(); });

function makeEntry(id: string, title: string): Entry {
    return {
        id, title, username: 'user', password: 'pw',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
    };
}

function makeModel(): Database {
    const root: Group = {
        id: 'root', name: 'Root', groups: [],
        entries: [makeEntry('e1', 'Alpha'), makeEntry('e2', 'Beta')],
    };
    return { name: 'db', groups: [], root };
}

const refs = () => ({
    entryDirty: { current: false } as React.MutableRefObject<boolean>,
    saveFailed: { current: false } as React.MutableRefObject<boolean>,
    savesInFlight: { current: 0 } as React.MutableRefObject<number>,
});

const view = (searchQuery: string, r: ReturnType<typeof refs>) => (
    <PasswordView
        database={makeModel()}
        searchQuery={searchQuery}
        onDatabaseChange={async () => true}
        entryDirty={r.entryDirty}
        saveFailed={r.saveFailed}
        savesInFlight={r.savesInFlight}
        onSearch={() => {}}
    />
);

async function openAndEdit(utils: any) {
    await act(async () => { fireEvent.click(utils.getByText('Alpha')); });
    await act(async () => { fireEvent.click(utils.getByTitle('Edit entry')); });
    const title = utils.getByPlaceholderText('Enter title') as HTMLInputElement;
    await act(async () => { fireEvent.change(title, { target: { value: 'Alpha renamed' } }); });
    return title;
}

describe('a search while an entry edit is dirty', () => {
    it('keeps the form, the typed values and the dirty flag', async () => {
        const r = refs();
        const utils = render(view('', r));
        const title = await openAndEdit(utils);
        expect(r.entryDirty.current).toBe(true);

        await act(async () => { utils.rerender(view('a', r)); });

        expect(utils.queryByPlaceholderText('Enter title')).not.toBeNull();
        expect((utils.getByPlaceholderText('Enter title') as HTMLInputElement).value).toBe('Alpha renamed');
        expect(r.entryDirty.current).toBe(true);
        expect(title.value).toBe('Alpha renamed');
    });

    it('does not interrupt typing with a prompt', async () => {
        const r = refs();
        const utils = render(view('', r));
        await openAndEdit(utils);

        const before = confirmSpy.mock.calls.length;
        await act(async () => { utils.rerender(view('a', r)); });
        expect(confirmSpy.mock.calls.length - before).toBe(0);
    });

    it('still clears the selection when nothing is dirty', async () => {
        const r = refs();
        const utils = render(view('', r));
        await act(async () => { utils.getByText('Alpha').click(); });
        expect(r.entryDirty.current).toBe(false);

        await act(async () => { utils.rerender(view('a', r)); });
        expect(utils.queryByTitle('Edit entry')).toBeNull();
    });

    it('still prompts when a different entry is selected', async () => {
        const r = refs();
        const utils = render(view('', r));
        await openAndEdit(utils);

        const before = confirmSpy.mock.calls.length;
        await act(async () => { fireEvent.click(utils.getByText('Beta')); });
        expect(confirmSpy.mock.calls.length - before).toBe(1);
    });
});

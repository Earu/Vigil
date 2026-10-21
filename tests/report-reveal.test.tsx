// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import React, { useState } from 'react';
import { Database, Entry, Group } from '../src/types/database';

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

function makeEntry(id: string, title: string, password: string): Entry {
    return {
        id, title, username: 'user', password,
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
    };
}

function makeModel(): Database {
    const work: Group = {
        id: 'work', name: 'Work', groups: [],
        entries: [makeEntry('e1', 'Alpha', 'shared-pw-1'), makeEntry('e2', 'Beta', 'shared-pw-1')],
    };
    const root: Group = {
        id: 'root', name: 'Root', groups: [work],
        entries: [makeEntry('e3', 'Gamma', 'own-pw-9')],
    };
    return { name: 'db', groups: [], root };
}

const Host = ({ onSearch, onReportOpen }: { onSearch: (q: string) => void; onReportOpen: (open: boolean) => void }) => {
    const [query, setQuery] = useState('zzz');
    const [database] = useState(makeModel);
    return (
        <PasswordView
            database={database}
            searchQuery={query}
            onDatabaseChange={async () => true}
            securityReportRequestId={1}
            onSecurityReportOpenChange={onReportOpen}
            entryDirty={{ current: false }}
            saveFailed={{ current: false }}
            savesInFlight={{ current: 0 }}
            onSearch={(q) => { onSearch(q); setQuery(q); }}
        />
    );
};

describe('clicking an entry in the security report', () => {
    it('closes the report and selects the entry in its group with the search cleared', async () => {
        const onSearch = vi.fn();
        const onReportOpen = vi.fn();
        const utils = render(<Host onSearch={onSearch} onReportOpen={onReportOpen} />);
        await act(async () => {});

        const dialog = utils.getByRole('dialog');
        expect(onReportOpen).toHaveBeenLastCalledWith(true);
        await act(async () => { fireEvent.click(within(dialog).getByRole('tab', { name: /Reused/ })); });
        await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /Beta/ })); });

        expect(utils.queryByRole('dialog')).toBeNull();
        expect(onReportOpen).toHaveBeenLastCalledWith(false);
        expect(onSearch).toHaveBeenCalledWith('');
        expect(utils.getByRole('treeitem', { name: /Work/ }).getAttribute('aria-selected')).toBe('true');
        expect(utils.getByRole('row', { selected: true }).textContent).toContain('Beta');
        expect(utils.queryByTitle('Edit entry')).not.toBeNull();
        expect(document.activeElement?.getAttribute('aria-label')).toBe('Entries');
    });
});

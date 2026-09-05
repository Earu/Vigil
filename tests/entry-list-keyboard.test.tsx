// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import React, { useState } from 'react';
import { EntryList } from '../src/components/PasswordView/EntryList';
import { Database, Entry, Group } from '../src/types/database';
import { expectNoA11yViolations } from './a11y';

// The entry list is windowed: rows leave the DOM when scrolled away, so
// keyboard focus stays on the grid and the row it is on is the active
// descendant.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
afterEach(cleanup);

function makeEntry(id: string, title: string): Entry {
    return {
        id, title, username: 'u', password: 'p',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
    };
}

function makeModel(count: number): { database: Database; root: Group } {
    const entries = Array.from({ length: count }, (_, i) => makeEntry(`id${i}+/=`, `entry ${String(i).padStart(2, '0')}`));
    const root: Group = { id: 'root', name: 'Root', groups: [], entries };
    return { database: { name: 'db', groups: [], root }, root };
}

const Harness = ({ count, onOpen = () => {}, onRemove = () => {} }: { count: number; onOpen?: (e: Entry) => void; onRemove?: (e: Entry) => void }) => {
    const { database, root } = makeModel(count);
    const [selected, setSelected] = useState<Entry | null>(null);
    return (
        <EntryList
            group={root}
            searchQuery=""
            selectedEntry={selected}
            onEntrySelect={setSelected}
            database={database}
            onNewEntry={() => {}}
            onRemoveEntry={onRemove}
            onOpenEntry={onOpen}
        />
    );
};

const activeRow = (grid: HTMLElement) => document.getElementById(grid.getAttribute('aria-activedescendant')!);

describe('the entry list', () => {
    it('is a grid of rows with the count and the selection exposed', async () => {
        const { getByRole, container } = render(<Harness count={5} />);
        const grid = getByRole('grid', { name: 'Entries' });
        expect(grid.getAttribute('aria-rowcount')).toBe('5');
        expect(grid.tabIndex).toBe(0);
        const rows = container.querySelectorAll('[role="row"]');
        expect(rows.length).toBe(5);
        expect(rows[0].getAttribute('aria-rowindex')).toBe('1');
        expect(rows[0].getAttribute('aria-selected')).toBe('false');
        expect(rows[0].querySelector('[role="gridcell"]')).not.toBeNull();
        await expectNoA11yViolations(container);
    });

    it('moves the active row with the arrows and selects it', () => {
        const { getByRole, getByText } = render(<Harness count={5} />);
        const grid = getByRole('grid');
        act(() => grid.focus());
        expect(activeRow(grid)!.textContent).toContain('entry 00');
        fireEvent.keyDown(grid, { key: 'ArrowDown' });
        fireEvent.keyDown(grid, { key: 'ArrowDown' });
        const row = activeRow(grid)!;
        expect(row.textContent).toContain('entry 02');
        expect(row.getAttribute('aria-selected')).toBe('true');
        expect(row.classList.contains('active')).toBe(true);
        expect(getByText('entry 02').closest('[role="row"]')).toBe(row);
        expect(document.activeElement).toBe(grid);
    });

    it('renders the row it jumps to with End, beyond the window', () => {
        const { getByRole, container } = render(<Harness count={60} />);
        const grid = getByRole('grid');
        act(() => grid.focus());
        expect(container.querySelectorAll('[role="row"]').length).toBeLessThan(60);
        fireEvent.keyDown(grid, { key: 'End' });
        const row = activeRow(grid);
        expect(row).not.toBeNull();
        expect(row!.getAttribute('aria-rowindex')).toBe('60');
        fireEvent.keyDown(grid, { key: 'Home' });
        expect(activeRow(grid)!.getAttribute('aria-rowindex')).toBe('1');
    });

    it('opens on Enter and removes on Delete', () => {
        const onOpen = vi.fn();
        const onRemove = vi.fn();
        const { getByRole } = render(<Harness count={3} onOpen={onOpen} onRemove={onRemove} />);
        const grid = getByRole('grid');
        act(() => grid.focus());
        fireEvent.keyDown(grid, { key: 'ArrowDown' });
        fireEvent.keyDown(grid, { key: 'Enter' });
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: 'entry 01' }));
        fireEvent.keyDown(grid, { key: 'Delete' });
        expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ title: 'entry 01' }));
    });

    it('moves to the next entry whose title starts with the typed letters', () => {
        const { getByRole } = render(<Harness count={12} />);
        const grid = getByRole('grid');
        act(() => grid.focus());
        fireEvent.keyDown(grid, { key: 'e' });
        expect(activeRow(grid)!.textContent).toContain('entry 01');
        fireEvent.keyDown(grid, { key: 'e' });
        expect(activeRow(grid)!.textContent).toContain('entry 02');
        vi.useFakeTimers();
        try {
            vi.advanceTimersByTime(1100);
            for (const key of 'entry 1') fireEvent.keyDown(grid, { key });
            expect(activeRow(grid)!.textContent).toContain('entry 10');
            expect(document.activeElement).toBe(grid);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves keys from a row button alone', () => {
        const onRemove = vi.fn();
        const { getByRole } = render(<Harness count={3} onRemove={onRemove} />);
        const grid = getByRole('grid');
        act(() => grid.focus());
        const button = grid.querySelector('[aria-label="Remove entry"]')!;
        fireEvent.keyDown(button, { key: 'Delete' });
        expect(onRemove).not.toHaveBeenCalled();
    });
});

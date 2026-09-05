// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React, { useState } from 'react';
import { Sidebar } from '../src/components/PasswordView/Sidebar';
import { Database, Group } from '../src/types/database';
import { GroupSummary } from '../src/services/BreachCheckService';
import { expectNoA11yViolations } from './a11y';

// The group tree is the vault's primary navigation; it has to work from the
// keyboard alone, the way a native tree view does.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const group = (id: string, name: string, groups: Group[] = []): Group => ({ id, name, groups, entries: [] });

function makeModel(): Database {
    const child = group('child', 'Child');
    const work = group('work', 'Work', [child]);
    const home = group('home', 'Home');
    const root = group('root', 'Root', [work, home]);
    return { name: 'db', groups: root.groups, root };
}

const summaries = new Map<string, GroupSummary>([
    ['work', { breached: true, weak: false, breachedEmail: false, entryCount: 3 }],
]);

const Harness = ({ database, onEdit = () => {}, onRemove = () => {} }: { database: Database; onEdit?: (g: Group) => void; onRemove?: (g: Group) => void }) => {
    const [selected, setSelected] = useState<Group>(database.root);
    return (
        <Sidebar
            database={database}
            selectedGroup={selected}
            groupSummaries={summaries}
            onGroupSelect={setSelected}
            onNewGroup={() => {}}
            onRemoveGroup={onRemove}
            onEditGroup={onEdit}
        />
    );
};

const row = (getByRole: any, name: RegExp) => getByRole('treeitem', { name }) as HTMLElement;

describe('the group tree', () => {
    it('is a tree of labelled, levelled rows with one Tab stop', async () => {
        const { getByRole, container } = render(<Harness database={makeModel()} />);
        expect(getByRole('tree', { name: 'Groups' })).toBeTruthy();
        const root = row(getByRole, /^Root/);
        const work = row(getByRole, /^Work/);
        expect(root.getAttribute('aria-level')).toBe('1');
        expect(work.getAttribute('aria-level')).toBe('2');
        expect(row(getByRole, /^Child/).getAttribute('aria-level')).toBe('3');
        expect(work.getAttribute('aria-label')).toBe('Work, 3 entries, contains breached passwords');
        expect(work.getAttribute('aria-expanded')).toBe('true');
        expect(row(getByRole, /^Home/).hasAttribute('aria-expanded')).toBe(false);
        expect(root.tabIndex).toBe(0);
        expect(work.tabIndex).toBe(-1);
        await expectNoA11yViolations(container);
    });

    it('moves and selects with the arrows, Home and End', () => {
        const { getByRole } = render(<Harness database={makeModel()} />);
        const root = row(getByRole, /^Root/);
        root.focus();
        fireEvent.keyDown(root, { key: 'ArrowDown' });
        const work = row(getByRole, /^Work/);
        expect(document.activeElement).toBe(work);
        expect(work.getAttribute('aria-selected')).toBe('true');
        expect(work.tabIndex).toBe(0);
        fireEvent.keyDown(work, { key: 'End' });
        expect(document.activeElement).toBe(row(getByRole, /^Home/));
        fireEvent.keyDown(row(getByRole, /^Home/), { key: 'Home' });
        expect(document.activeElement).toBe(row(getByRole, /^Root/));
        fireEvent.keyDown(row(getByRole, /^Root/), { key: 'ArrowUp' });
        expect(document.activeElement).toBe(row(getByRole, /^Root/));
    });

    it('collapses and expands with Left and Right', () => {
        const { getByRole, queryByRole } = render(<Harness database={makeModel()} />);
        const work = row(getByRole, /^Work/);
        work.focus();
        fireEvent.keyDown(work, { key: 'ArrowLeft' });
        expect(work.getAttribute('aria-expanded')).toBe('false');
        expect(queryByRole('treeitem', { name: /^Child/ })).toBeNull();
        fireEvent.keyDown(work, { key: 'ArrowRight' });
        expect(work.getAttribute('aria-expanded')).toBe('true');
        fireEvent.keyDown(work, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(row(getByRole, /^Child/));
        fireEvent.keyDown(row(getByRole, /^Child/), { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(row(getByRole, /^Work/));
    });

    it('edits on F2 and removes on Delete, but never the root', () => {
        const onEdit = vi.fn();
        const onRemove = vi.fn();
        const { getByRole } = render(<Harness database={makeModel()} onEdit={onEdit} onRemove={onRemove} />);
        const root = row(getByRole, /^Root/);
        fireEvent.keyDown(root, { key: 'F2' });
        fireEvent.keyDown(root, { key: 'Delete' });
        expect(onEdit).not.toHaveBeenCalled();
        expect(onRemove).not.toHaveBeenCalled();
        const home = row(getByRole, /^Home/);
        fireEvent.keyDown(home, { key: 'F2' });
        fireEvent.keyDown(home, { key: 'Delete' });
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'home' }));
        expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'home' }));
    });

    it('ignores Enter from a nested action button', () => {
        const onEdit = vi.fn();
        const { getByRole } = render(<Harness database={makeModel()} onEdit={onEdit} />);
        const home = row(getByRole, /^Home/);
        home.focus();
        const edit = home.querySelector('[aria-label="Edit group"]')!;
        fireEvent.keyDown(edit, { key: 'F2' });
        expect(onEdit).not.toHaveBeenCalled();
    });

    it('renames the database from a real button', () => {
        const { getByRole, getByLabelText } = render(<Harness database={makeModel()} />);
        fireEvent.click(getByRole('button', { name: 'db, rename database' }));
        expect(document.activeElement).toBe(getByLabelText('Database name'));
    });
});

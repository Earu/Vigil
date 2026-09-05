// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { MoveToGroupDialog, parentGroupOf, parentOfGroup } from '../src/components/PasswordView/MoveToGroupDialog';
import { Database, Entry, Group } from '../src/types/database';
import { expectNoA11yViolations } from './a11y';

// The keyboard route for moving entries and groups: a dialog listing the
// destinations as radios, so arrows pick and Enter on Move confirms.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const entry = (id: string): Entry => ({ id, title: id, username: '', password: '', created: new Date(), modified: new Date(), attachments: [], history: [], expires: false, customFields: [], tags: [] });
const group = (id: string, name: string, groups: Group[] = [], entries: Entry[] = []): Group => ({ id, name, groups, entries });

function makeModel(): Database {
    const child = group('child', 'Child');
    const work = group('work', 'Work', [child], [entry('e1')]);
    const home = group('home', 'Home');
    const root = group('root', 'All Entries', [work, home]);
    return { name: 'db', groups: root.groups, root };
}

describe('the move dialog', () => {
    it('lists groups as a radio group with the current one marked, and moves on confirm', async () => {
        const database = makeModel();
        const onChoose = vi.fn();
        const { getByRole, getAllByRole, getByText, container } = render(
            <MoveToGroupDialog database={database} title='Move "e1" to' currentParentId="work" onChoose={onChoose} onCancel={() => {}} />
        );
        expect(getByRole('dialog', { name: 'Move "e1" to' })).toBeTruthy();
        expect(getByRole('radiogroup', { name: 'Destination group' })).toBeTruthy();
        expect(getAllByRole('radio').map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual(['All Entries', 'Workcurrent', 'Child', 'Home']);
        await expectNoA11yViolations(container);
        fireEvent.click(getAllByRole('radio')[3]);
        fireEvent.click(getByText('Move'));
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'home' }));
    });

    it('refuses the current parent as a destination', () => {
        const { getAllByRole, getByText } = render(
            <MoveToGroupDialog database={makeModel()} title="t" currentParentId="work" onChoose={() => {}} onCancel={() => {}} />
        );
        fireEvent.click(getAllByRole('radio')[1]);
        expect((getByText('Move') as HTMLButtonElement).disabled).toBe(true);
    });

    it('leaves out a moved group and its subtree', () => {
        const { getAllByRole } = render(
            <MoveToGroupDialog database={makeModel()} title="t" excludeId="work" currentParentId="root" onChoose={() => {}} onCancel={() => {}} />
        );
        expect(getAllByRole('radio').map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual(['All Entriescurrent', 'Home']);
    });

    it('filters by name and cancels on Escape', () => {
        const onCancel = vi.fn();
        const { getByLabelText, getAllByRole } = render(
            <MoveToGroupDialog database={makeModel()} title="t" onChoose={() => {}} onCancel={onCancel} />
        );
        fireEvent.change(getByLabelText('Filter groups'), { target: { value: 'ho' } });
        expect(getAllByRole('radio').length).toBe(1);
        fireEvent.keyDown(getByLabelText('Filter groups'), { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });
});

describe('parent lookups', () => {
    it('find the group holding an entry or a subgroup', () => {
        const { root } = makeModel();
        expect(parentGroupOf(root, 'e1')!.id).toBe('work');
        expect(parentGroupOf(root, 'nope')).toBeNull();
        expect(parentOfGroup(root, 'child')!.id).toBe('work');
        expect(parentOfGroup(root, 'work')!.id).toBe('root');
        expect(parentOfGroup(root, 'root')).toBeNull();
    });
});

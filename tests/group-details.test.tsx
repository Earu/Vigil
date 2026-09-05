// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import * as kdbxweb from 'kdbxweb';
import { GroupDetails } from '../src/components/PasswordView/GroupDetails';
import { Group } from '../src/types/database';
import { expectNoA11yViolations } from './a11y';

// The group editing panel: name and icon changes reach onSave; the default
// folder selection maps to "no icon set"; a stored custom icon shows with a
// remove path back to the standard picker.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeGroup(over: Partial<Group> = {}): Group {
    return { id: 'g1', name: 'Work', groups: [], entries: [], ...over };
}

afterEach(cleanup);

describe('GroupDetails', () => {
    it('labels its fields and passes axe', async () => {
        const { getByLabelText, container } = render(
            <GroupDetails group={makeGroup()} onClose={vi.fn()} onSave={vi.fn()} />
        );
        expect(getByLabelText('Name')).toBeTruthy();
        await expectNoA11yViolations(container);
    });

    it('saves a rename', () => {
        const onSave = vi.fn();
        const { getByPlaceholderText, getByText } = render(
            <GroupDetails group={makeGroup()} onClose={vi.fn()} onSave={onSave} />
        );
        fireEvent.change(getByPlaceholderText('Group name'), { target: { value: '  Projects ' } });
        fireEvent.click(getByText('Save'));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), {
            name: 'Projects', icon: undefined, customIcon: undefined,
        });
    });

    it('saves a picked icon, with the folder default mapping to none', () => {
        const onSave = vi.fn();
        const { container, getByText } = render(
            <GroupDetails group={makeGroup()} onClose={vi.fn()} onSave={onSave} />
        );
        const options = container.querySelectorAll('.group-icon-option');
        expect(options.length).toBe(69);
        // The folder default renders selected for a group with no icon
        expect(options[48].classList.contains('selected')).toBe(true);

        fireEvent.click(options[kdbxweb.Consts.Icons.Money]);
        fireEvent.click(getByText('Save'));
        expect(onSave.mock.calls[0][1].icon).toBe(kdbxweb.Consts.Icons.Money);

        onSave.mockClear();
        fireEvent.click(options[48]);
        fireEvent.click(getByText('Save'));
        expect(onSave.mock.calls[0][1].icon).toBeUndefined();
    });

    it('preserves an untouched icon by leaving it out of the save', () => {
        const onSave = vi.fn();
        const { container, getByText } = render(
            <GroupDetails group={makeGroup({ customIcon: 'not-in-cache' })} onClose={vi.fn()} onSave={onSave} />
        );
        expect(container.querySelector('.group-icon-grid')).not.toBeNull();

        // No icon interaction: the payload omits the icon keys entirely, so
        // a concurrent icon change merged in while the panel was open survives
        fireEvent.click(getByText('Save'));
        expect('icon' in onSave.mock.calls[0][1]).toBe(false);
        expect('customIcon' in onSave.mock.calls[0][1]).toBe(false);
    });

    it('clears a set icon through the Remove icon button', () => {
        const onSave = vi.fn();
        const { getByText, queryByText } = render(
            <GroupDetails group={makeGroup({ icon: kdbxweb.Consts.Icons.Money })} onClose={vi.fn()} onSave={onSave} />
        );
        fireEvent.click(getByText('Remove icon'));
        expect(queryByText('Remove icon')).toBeNull();
        fireEvent.click(getByText('Save'));
        expect(onSave.mock.calls[0][1]).toMatchObject({ icon: undefined, customIcon: undefined });
    });

    it('refuses to save an empty name', () => {
        const onSave = vi.fn();
        const { getByPlaceholderText, getByText } = render(
            <GroupDetails group={makeGroup()} onClose={vi.fn()} onSave={onSave} />
        );
        fireEvent.change(getByPlaceholderText('Group name'), { target: { value: '   ' } });
        fireEvent.click(getByText('Save'));
        expect(onSave).not.toHaveBeenCalled();
        expect((getByText('Save') as HTMLButtonElement).disabled).toBe(true);
    });
});

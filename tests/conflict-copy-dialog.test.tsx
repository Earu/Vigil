// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { ConflictCopyDialog, describeChanges, hasChanges } from '../src/components/ConflictCopyDialog';
import { expectNoA11yViolations } from './a11y';

// The dialog says what the merge did and offers a save only when there is
// something to save.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const changes = (added: number, updated: number, removed: number, groups = 0) => ({ added, updated, removed, groups });
const request = (c: ReturnType<typeof changes>) => ({ copyName: 'vault 2.kdbx', vaultName: 'vault.kdbx', changes: c });

describe('a copy that brought changes', () => {
    it('says what came over and ties trashing to a save', () => {
        const { getByText } = render(
            <ConflictCopyDialog request={request(changes(2, 1, 0))} onTrash={() => {}} onKeep={() => {}} />
        );
        expect(getByText(/It had 2 new entries and 1 entry with newer changes, which are now in this vault\. Save it and move the copy to the trash\?/)).toBeTruthy();
        expect(getByText('Save and Trash the Copy')).toBeTruthy();
    });
});

describe('a copy the vault had already outgrown', () => {
    it('offers a plain trash', () => {
        const { getByText, queryByText } = render(
            <ConflictCopyDialog request={request(changes(0, 0, 0))} onTrash={() => {}} onKeep={() => {}} />
        );
        expect(getByText(/Everything in it is already in this vault\. Move it to the trash\?/)).toBeTruthy();
        expect(getByText('Trash the Copy')).toBeTruthy();
        expect(queryByText('Save and Trash the Copy')).toBeNull();
    });
});

describe('the buttons', () => {
    it('answer keep and trash, with keep focused by default', () => {
        const answers: string[] = [];
        const { getByText } = render(
            <ConflictCopyDialog request={request(changes(1, 0, 0))}
                onTrash={() => answers.push('trash')} onKeep={() => answers.push('keep')} />
        );
        expect(document.activeElement).toBe(getByText('Keep the Copy'));
        fireEvent.click(getByText('Save and Trash the Copy'));
        fireEvent.click(getByText('Keep the Copy'));
        expect(answers).toEqual(['trash', 'keep']);
    });

    it('is an alert dialog that keeps the copy on Escape', async () => {
        const onKeep = vi.fn();
        const { container, getByText } = render(
            <ConflictCopyDialog request={request(changes(1, 0, 0))} onTrash={() => {}} onKeep={onKeep} />
        );
        const dialog = container.querySelector('[role="alertdialog"]')!;
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        await expectNoA11yViolations(container);
        fireEvent.keyDown(getByText('Keep the Copy'), { key: 'Escape' });
        expect(onKeep).toHaveBeenCalledTimes(1);
    });
});

describe('describeChanges', () => {
    it('reads like a sentence for any combination', () => {
        expect(describeChanges(changes(1, 0, 0))).toBe('1 new entry');
        expect(describeChanges(changes(3, 2, 0))).toBe('3 new entries and 2 entries with newer changes');
        expect(describeChanges(changes(3, 2, 1))).toBe('3 new entries, 2 entries with newer changes and 1 entry deleted there');
        expect(describeChanges(changes(0, 0, 0, 2))).toBe('2 folder changes');
        expect(describeChanges(changes(1, 0, 0, 1))).toBe('1 new entry and 1 folder change');
        expect(hasChanges(changes(0, 0, 0))).toBe(false);
        expect(hasChanges(changes(0, 0, 0, 1))).toBe(true);
    });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { installPaneCycle, nextPane, paneTargets } from '../src/components/PasswordView/paneCycle';

// F6 walks tree, list, details and back; Shift+F6 the other way; a dialog
// keeps the keyboard.

const build = (withDetails: boolean) => {
    document.body.innerHTML = `
        <input id="search">
        <div class="content">
            <div class="sidebar"><div role="tree">
                <div role="treeitem" tabindex="-1" id="root">Root</div>
                <div role="treeitem" tabindex="0" id="work">Work</div>
            </div></div>
            <div class="entry-list"><div role="grid" tabindex="0" id="grid"></div></div>
            ${withDetails ? '<div class="entry-details" tabindex="-1" id="details"><button id="edit">Edit</button></div>' : ''}
        </div>`;
    return document.querySelector('.content')!;
};
const el = (id: string) => document.getElementById(id)!;
const press = (shift = false) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', shiftKey: shift, bubbles: true }));

afterEach(() => { document.body.innerHTML = ''; });

describe('pane cycling', () => {
    it('lands on the tree\'s current row, the grid, then the details panel, and wraps', () => {
        const root = build(true);
        const targets = paneTargets(root);
        expect(targets.map((t) => t.id)).toEqual(['work', 'grid', 'details']);
        expect(nextPane(targets, el('search'), false)!.id).toBe('work');
        expect(nextPane(targets, el('work'), false)!.id).toBe('grid');
        expect(nextPane(targets, el('grid'), false)!.id).toBe('details');
        expect(nextPane(targets, el('edit'), false)!.id).toBe('work');
        expect(nextPane(targets, el('work'), true)!.id).toBe('details');
        expect(nextPane(targets, el('search'), true)!.id).toBe('details');
    });

    it('skips a closed details panel', () => {
        const targets = paneTargets(build(false));
        expect(nextPane(targets, el('grid'), false)!.id).toBe('work');
    });

    it('moves focus on F6 and Shift+F6, and stays out of an open dialog', () => {
        const root = build(true);
        const stop = installPaneCycle(() => root);
        el('search').focus();
        press();
        expect(document.activeElement).toBe(el('work'));
        press();
        expect(document.activeElement).toBe(el('grid'));
        press(true);
        expect(document.activeElement).toBe(el('work'));
        document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button id="in-dialog">Ok</button></div>');
        el('in-dialog').focus();
        press();
        expect(document.activeElement).toBe(el('in-dialog'));
        stop();
        el('search').focus();
        press();
        expect(document.activeElement).toBe(el('search'));
    });
});

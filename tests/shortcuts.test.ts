// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { matchesChord, chordKeys, SHORTCUT_GROUPS } from '../src/services/Shortcuts';

// One chord table feeds both the key handlers and the Settings > Info list.

const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
const mac = (on: boolean) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(on ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (X11; Linux x86_64)');

afterEach(() => vi.restoreAllMocks());

describe('matchesChord', () => {
    it('uses Ctrl off macOS and Cmd on it, and nothing else', () => {
        mac(false);
        expect(matchesChord(ev({ key: 'f', ctrlKey: true }), 'Mod+F')).toBe(true);
        expect(matchesChord(ev({ key: 'F', ctrlKey: true }), 'Mod+F')).toBe(true);
        expect(matchesChord(ev({ key: 'f', metaKey: true }), 'Mod+F')).toBe(false);
        expect(matchesChord(ev({ key: 'f', ctrlKey: true, shiftKey: true }), 'Mod+F')).toBe(false);
        expect(matchesChord(ev({ key: 'f', ctrlKey: true, altKey: true }), 'Mod+F')).toBe(false);
        expect(matchesChord(ev({ key: 'f' }), 'Mod+F')).toBe(false);
        mac(true);
        expect(matchesChord(ev({ key: 'f', metaKey: true }), 'Mod+F')).toBe(true);
        expect(matchesChord(ev({ key: 'f', ctrlKey: true }), 'Mod+F')).toBe(false);
    });

    it('handles punctuation and named keys', () => {
        mac(false);
        expect(matchesChord(ev({ key: ',', ctrlKey: true }), 'Mod+,')).toBe(true);
        expect(matchesChord(ev({ key: 'Enter', ctrlKey: true }), 'Mod+Enter')).toBe(true);
        expect(matchesChord(ev({ key: 'Enter' }), 'Mod+Enter')).toBe(false);
        expect(matchesChord(ev({ key: 'F6', shiftKey: true }), 'Shift+F6')).toBe(true);
        expect(matchesChord(ev({ key: 'F6' }), 'Shift+F6')).toBe(false);
    });
});

describe('the shortcut table', () => {
    it('shows the platform command key', () => {
        mac(false);
        expect(chordKeys('Mod+F')).toEqual(['Ctrl', 'F']);
        mac(true);
        expect(chordKeys('Mod+Shift+F')).toEqual(['Cmd', 'Shift', 'F']);
    });

    it('lists every chord once per group', () => {
        for (const group of SHORTCUT_GROUPS) {
            const chords = group.rows.map((r) => r.chord);
            expect(new Set(chords).size).toBe(chords.length);
        }
    });
});

describe('zoomAction', () => {
    it('reads plus, minus and zero with the platform key', async () => {
        const { zoomAction } = await import('../src/services/Shortcuts');
        mac(false);
        expect(zoomAction(ev({ key: '=', ctrlKey: true }))).toBe('in');
        expect(zoomAction(ev({ key: '+', ctrlKey: true, shiftKey: true }))).toBe('in');
        expect(zoomAction(ev({ key: '-', ctrlKey: true }))).toBe('out');
        expect(zoomAction(ev({ key: '0', ctrlKey: true }))).toBe('reset');
        expect(zoomAction(ev({ key: '0', ctrlKey: true, shiftKey: true }))).toBeNull();
        expect(zoomAction(ev({ key: '=' }))).toBeNull();
        expect(zoomAction(ev({ key: '=', metaKey: true }))).toBeNull();
        mac(true);
        expect(zoomAction(ev({ key: '=', metaKey: true }))).toBe('in');
    });
});

describe('the action registry', () => {
    it('runs the registered action and forgets it on unregister', async () => {
        const { registerAction, runAction } = await import('../src/services/Shortcuts');
        const calls: string[] = [];
        const stop = registerAction('lock', () => calls.push('lock'));
        expect(runAction('lock')).toBe(true);
        expect(runAction('search')).toBe(false);
        stop();
        expect(runAction('lock')).toBe(false);
        expect(calls).toEqual(['lock']);
    });

    it('lets a newer registration replace an older one without the old cleanup removing it', async () => {
        const { registerAction, runAction } = await import('../src/services/Shortcuts');
        const calls: string[] = [];
        const stopOld = registerAction('edit', () => calls.push('old'));
        registerAction('edit', () => calls.push('new'));
        stopOld();
        runAction('edit');
        expect(calls).toEqual(['new']);
    });
});

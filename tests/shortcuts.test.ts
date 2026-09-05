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

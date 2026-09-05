import { describe, it, expect } from 'vitest';
import { findTypeAheadMatch, isTypeAheadKey } from '../src/components/typeAhead';

// Type-ahead picks items by their names the way a native list view does.

const names = ['Root', 'Work', 'Web', 'Home', 'Hobbies'];

describe('type-ahead matching', () => {
    it('finds the next item starting with a letter, wrapping', () => {
        expect(findTypeAheadMatch('h', names, 0)).toBe(3);
        expect(findTypeAheadMatch('h', names, 3)).toBe(4);
        expect(findTypeAheadMatch('h', names, 4)).toBe(3);
        expect(findTypeAheadMatch('r', names, 0)).toBe(0);
    });

    it('narrows with a longer prefix and stays on the current match', () => {
        expect(findTypeAheadMatch('we', names, 1)).toBe(2);
        expect(findTypeAheadMatch('wo', names, 1)).toBe(1);
        expect(findTypeAheadMatch('HOB', names, 0)).toBe(4);
    });

    it('cycles on a repeated letter', () => {
        expect(findTypeAheadMatch('hh', names, 3)).toBe(4);
        expect(findTypeAheadMatch('hhh', names, 4)).toBe(3);
    });

    it('reports no match', () => {
        expect(findTypeAheadMatch('z', names, 0)).toBe(-1);
        expect(findTypeAheadMatch('', names, 0)).toBe(-1);
        expect(findTypeAheadMatch('a', [], 0)).toBe(-1);
    });

    it('takes printable keys without modifiers only', () => {
        const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
            ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
        expect(isTypeAheadKey(key('a'))).toBe(true);
        expect(isTypeAheadKey(key(' '))).toBe(true);
        expect(isTypeAheadKey(key('a', { ctrlKey: true }))).toBe(false);
        expect(isTypeAheadKey(key('ArrowDown'))).toBe(false);
        expect(isTypeAheadKey(key('F2'))).toBe(false);
    });
});

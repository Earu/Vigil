import { describe, it, expect } from 'vitest';
import { pipeNameFor } from '../electron/src/browser-socket';

describe('windows pipe name', () => {
    it('is scoped to the user, as KeePassXC does', () => {
        expect(pipeNameFor('alice')).toBe('\\\\.\\pipe\\vigil.BrowserServer_alice');
        expect(pipeNameFor('alice')).not.toBe(pipeNameFor('bob'));
    });

    it('stays a valid pipe path for names with spaces or punctuation', () => {
        expect(pipeNameFor('Jean Dupont')).toBe('\\\\.\\pipe\\vigil.BrowserServer_Jean_Dupont');
        expect(pipeNameFor('a\\b/c')).toBe('\\\\.\\pipe\\vigil.BrowserServer_a_b_c');
        expect(pipeNameFor('')).toBe('\\\\.\\pipe\\vigil.BrowserServer_user');
    });
});

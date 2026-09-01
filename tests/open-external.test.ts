import { describe, it, expect, beforeEach, vi } from 'vitest';

// Entry URLs are attacker-controllable (imported vaults, shared databases), so
// what reaches shell.openExternal is the thing under test
const opened: string[] = [];
let openThrows = false;

vi.mock('electron', () => ({
    clipboard: { writeText: () => {} },
    shell: {
        openExternal: async (url: string) => {
            if (openThrows) throw new Error('no handler');
            opened.push(url);
        },
    },
}));

const { openExternal } = await import('../electron/src/utils');

beforeEach(() => {
    opened.length = 0;
    openThrows = false;
});

describe('openExternal scheme allowlist', () => {
    it('opens http and https links', async () => {
        expect(await openExternal('https://example.com/login')).toEqual({ success: true });
        expect(await openExternal('http://example.com')).toEqual({ success: true });
        expect(opened).toEqual(['https://example.com/login', 'http://example.com/']);
    });

    it('opens mailto links', async () => {
        expect((await openExternal('mailto:someone@example.com')).success).toBe(true);
        expect(opened).toEqual(['mailto:someone@example.com']);
    });

    it('assumes https for a bare host, which URL fields commonly hold', async () => {
        expect((await openExternal('example.com/path')).success).toBe(true);
        expect(opened).toEqual(['https://example.com/path']);
    });

    it.each([
        'file:///etc/passwd',
        'file://server/share/payload.exe',
        'smb://attacker.example/share',
        'ms-msdt:/id PCWDiagnostic',
        'vbscript:msgbox(1)',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'ssh://root@example.com',
    ])('refuses %s and opens nothing', async (url) => {
        const result = await openExternal(url);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Refused to open/);
        expect(opened).toEqual([]);
    });

    it('refuses a scheme dressed up with whitespace or case', async () => {
        expect((await openExternal('  FILE:///etc/passwd  ')).success).toBe(false);
        expect((await openExternal('JavaScript:alert(1)')).success).toBe(false);
        expect(opened).toEqual([]);
    });

    it('rejects something that cannot be parsed as a link at all', async () => {
        const result = await openExternal('http://');
        expect(result.success).toBe(false);
        expect(opened).toEqual([]);
    });

    it('reports a failure from the platform opener instead of throwing', async () => {
        openThrows = true;
        const result = await openExternal('https://example.com');
        expect(result).toEqual({ success: false, error: 'Failed to open the link' });
    });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

// A packaged build must refuse Chromium's remote debugging switches: they
// hand the renderer, and with it the preload bridge, to whoever launched the
// process, which is the capability the fuses were set to remove

const exit = vi.fn();
let packaged = true;
let switches = new Set<string>();

vi.mock('electron', () => ({
    app: {
        get isPackaged() { return packaged; },
        exit: (code: number) => exit(code),
        commandLine: { hasSwitch: (name: string) => switches.has(name) },
    },
}));

const { findDebugSwitch, refuseDebugSwitches, DEBUG_SWITCHES } = await import('../electron/src/launch-guard');

beforeEach(() => {
    exit.mockReset();
    packaged = true;
    switches = new Set();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

describe('findDebugSwitch', () => {
    it('names the first debugging switch present', () => {
        expect(findDebugSwitch(() => false)).toBeNull();
        expect(findDebugSwitch(name => name === 'remote-debugging-port')).toBe('remote-debugging-port');
        expect(findDebugSwitch(name => name === 'remote-debugging-pipe')).toBe('remote-debugging-pipe');
        expect(findDebugSwitch(name => name === 'inspect')).toBe('inspect');
    });

    it('covers both remote debugging transports', () => {
        expect(DEBUG_SWITCHES).toContain('remote-debugging-port');
        expect(DEBUG_SWITCHES).toContain('remote-debugging-pipe');
    });
});

describe('refuseDebugSwitches', () => {
    it('exits a packaged build launched with a debugging switch', () => {
        switches.add('remote-debugging-port');
        refuseDebugSwitches();
        expect(exit).toHaveBeenCalledWith(1);
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('--remote-debugging-port'));
    });

    it('lets a clean launch through', () => {
        refuseDebugSwitches();
        expect(exit).not.toHaveBeenCalled();
    });

    it('leaves dev builds alone, where DevTools are open anyway', () => {
        packaged = false;
        switches.add('remote-debugging-port');
        refuseDebugSwitches();
        expect(exit).not.toHaveBeenCalled();
    });
});

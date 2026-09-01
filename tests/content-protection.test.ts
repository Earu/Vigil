import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The module reads its config from userData and drives BrowserWindow, so both
// are stubbed. Each case gets its own userData dir
let userData = '';
const windows: Array<{ isDestroyed: () => boolean; setContentProtection: (v: boolean) => void }> = [];
let platform = 'win32';

vi.mock('electron', () => ({
    app: { getPath: () => userData },
    BrowserWindow: { getAllWindows: () => windows },
}));

const load = async () => {
    vi.resetModules();
    return await import('../electron/src/content-protection');
};

const configPath = () => path.join(userData, 'window-protection.json');

beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-cp-'));
    windows.length = 0;
    platform = 'win32';
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

describe('content protection default', () => {
    it('is on with no config written yet', async () => {
        const cp = await load();
        expect(cp.isContentProtectionEnabled()).toBe(true);
    });

    it('stays on when the config is corrupt rather than failing open', async () => {
        fs.writeFileSync(configPath(), 'not json at all');
        const cp = await load();
        expect(cp.isContentProtectionEnabled()).toBe(true);
    });

    it('stays on for a config that is missing the key', async () => {
        fs.writeFileSync(configPath(), JSON.stringify({ somethingElse: 1 }));
        const cp = await load();
        expect(cp.isContentProtectionEnabled()).toBe(true);
    });

    it('honors an explicit false', async () => {
        fs.writeFileSync(configPath(), JSON.stringify({ enabled: false }));
        const cp = await load();
        expect(cp.isContentProtectionEnabled()).toBe(false);
    });
});

describe('toggling', () => {
    it('persists and applies to every open window', async () => {
        const applied: boolean[] = [];
        windows.push(
            { isDestroyed: () => false, setContentProtection: (v) => applied.push(v) },
            { isDestroyed: () => false, setContentProtection: (v) => applied.push(v) },
        );
        const cp = await load();

        expect(cp.setContentProtectionEnabled(false)).toEqual({ success: true, enabled: false });
        expect(applied).toEqual([false, false]);
        expect(JSON.parse(fs.readFileSync(configPath(), 'utf8')).enabled).toBe(false);
        expect(cp.isContentProtectionEnabled()).toBe(false);

        cp.setContentProtectionEnabled(true);
        expect(cp.isContentProtectionEnabled()).toBe(true);
    });

    it('skips destroyed windows', async () => {
        let called = false;
        windows.push({ isDestroyed: () => true, setContentProtection: () => { called = true; } });
        const cp = await load();
        cp.setContentProtectionEnabled(true);
        expect(called).toBe(false);
    });
});

describe('platform support', () => {
    it('is unsupported and reported off on linux', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const cp = await load();
        expect(cp.isSupported()).toBe(false);
        expect(cp.isContentProtectionEnabled()).toBe(false);
        const result = cp.setContentProtectionEnabled(true);
        expect(result.success).toBe(false);
        expect(fs.existsSync(configPath())).toBe(false);
    });

    it('is supported on macOS and Windows', async () => {
        for (const p of ['darwin', 'win32']) {
            Object.defineProperty(process, 'platform', { value: p, configurable: true });
            const cp = await load();
            expect(cp.isSupported()).toBe(true);
        }
    });
});

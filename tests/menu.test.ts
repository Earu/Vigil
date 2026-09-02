import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module only talks to Electron's Menu and app, so both are stubbed and
// the template it builds is captured for inspection
let isPackaged = true;
let built: unknown = null;
let template: any[] | null = null;
let setMenuCalls: unknown[] = [];

vi.mock('electron', () => ({
    app: { get isPackaged() { return isPackaged; } },
    Menu: {
        buildFromTemplate: (t: any[]) => { template = t; built = { menu: true }; return built; },
        setApplicationMenu: (menu: unknown) => { setMenuCalls.push(menu); },
    },
}));

const load = async () => {
    vi.resetModules();
    return await import('../electron/src/menu');
};

const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

beforeEach(() => {
    isPackaged = true;
    built = null;
    template = null;
    setMenuCalls = [];
    setPlatform('darwin');
});

describe('development', () => {
    it('leaves the default menu alone so DevTools stays reachable', async () => {
        isPackaged = false;
        for (const platform of ['darwin', 'win32', 'linux']) {
            setPlatform(platform);
            const menu = await load();
            menu.applyApplicationMenu();
        }
        expect(setMenuCalls).toEqual([]);
    });
});

describe('packaged builds', () => {
    it('removes the menu entirely on windows and linux', async () => {
        for (const platform of ['win32', 'linux']) {
            setMenuCalls = [];
            setPlatform(platform);
            const menu = await load();
            menu.applyApplicationMenu();
            expect(setMenuCalls).toEqual([null]);
        }
    });

    // Dropping the menu on macOS would take Cmd+C/V/X/A with it, since AppKit
    // routes those through the menu rather than the focused control
    it('keeps a menu on macOS rather than removing it', async () => {
        const menu = await load();
        menu.applyApplicationMenu();
        expect(setMenuCalls).toEqual([built]);
        expect(built).not.toBeNull();
    });

    it('keeps the edit and app roles macOS needs for clipboard and quit', async () => {
        const menu = await load();
        menu.applyApplicationMenu();
        const roles = (template ?? []).map(item => item.role);
        expect(roles).toContain('editMenu');
        expect(roles).toContain('appMenu');
        expect(roles).toContain('windowMenu');
    });

    it('carries no View submenu, which is where Toggle Developer Tools lives', async () => {
        const menu = await load();
        menu.applyApplicationMenu();
        const roles = (template ?? []).map(item => item.role);
        expect(roles).not.toContain('viewMenu');
        expect(JSON.stringify(template).toLowerCase()).not.toContain('devtools');
    });
});

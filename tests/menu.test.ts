import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module only talks to Electron's Menu and app, so both are stubbed and
// the template it builds is captured for inspection
let isPackaged = true;
let built: unknown = null;
let template: any[] | null = null;
let setMenuCalls: unknown[] = [];

let sent: unknown[][] = [];
vi.mock('electron', () => ({
    app: { get isPackaged() { return isPackaged; }, name: 'Vigil' },
    BrowserWindow: { getFocusedWindow: () => ({ webContents: { send: (...args: unknown[]) => { sent.push(args); } } }) },
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
    sent = [];
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

    it('keeps the edit, app and window items macOS needs for clipboard and quit', async () => {
        const menu = await load();
        menu.applyApplicationMenu();
        const roles = (template ?? []).map(item => item.role);
        expect(roles).toContain('editMenu');
        expect(roles).toContain('windowMenu');
        const appMenu = template![0];
        expect(appMenu.label).toBe('Vigil');
        const appRoles = appMenu.submenu.map((item: any) => item.role);
        expect(appRoles).toContain('quit');
        expect(appRoles).toContain('hide');
    });

    it('carries no Developer Tools anywhere, and a View menu of zoom only', async () => {
        const menu = await load();
        menu.applyApplicationMenu();
        const roles = (template ?? []).map(item => item.role);
        expect(roles).not.toContain('viewMenu');
        expect(JSON.stringify(template).toLowerCase()).not.toContain('devtools');
        expect(JSON.stringify(template).toLowerCase()).not.toContain('reload');
        const view = template!.find(item => item.label === 'View');
        expect(view.submenu.map((item: any) => item.role)).toEqual(['zoomIn', 'zoomOut', 'resetZoom']);
    });

    it('lists the app shortcuts with their accelerators and sends the action to the focused window', async () => {
        const menu = await load();
        menu.applyApplicationMenu();
        const items = template!.flatMap(item => item.submenu ?? []).filter((item: any) => item.accelerator);
        const byAccelerator = Object.fromEntries(items.map((item: any) => [item.accelerator, item.label]));
        expect(byAccelerator).toEqual({
            'CmdOrCtrl+,': 'Settings\u2026',
            'CmdOrCtrl+F': 'Search',
            'CmdOrCtrl+N': 'New Entry',
            'CmdOrCtrl+L': 'Lock',
            'CmdOrCtrl+E': 'Edit',
            'CmdOrCtrl+M': 'Move to Group\u2026',
            'CmdOrCtrl+B': 'Copy Username',
            'CmdOrCtrl+T': 'Copy One-Time Code',
            'CmdOrCtrl+U': 'Open URL',
        });
        items.find((item: any) => item.label === 'Lock').click();
        expect(sent).toEqual([['menu-action', 'lock']]);
    });
});

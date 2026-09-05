import { Menu, MenuItemConstructorOptions, BrowserWindow, app } from 'electron';

// Electron installs a default menu whenever the app sets none, and that menu
// carries View -> Toggle Developer Tools. In a packaged build that is a way
// straight past everything else here: DevTools on an unlocked vault reads
// every decrypted field out of the renderer, and the screen-capture
// protection does not apply because nothing is being captured. So a release
// build gets a menu built here, with no DevTools item anywhere in it.
//
// The menu cannot simply be dropped on macOS. AppKit routes Cmd+C/V/X/A/Z and
// Cmd+Q through the menu rather than the focused control, so
// setApplicationMenu(null) there costs the app every text-editing shortcut it
// has, in the search box and in every entry field. Windows and Linux take
// those from Chromium directly and need no menu at all, and their windows are
// frameless, so nothing is drawn either way.
//
// The Vault and Entry menus list the app's own shortcuts so the menu bar
// shows them. Their items send the action to the renderer, which owns the
// behaviour (src/services/Shortcuts.ts); the page sees the key first and,
// when it handles the chord itself, the menu item never fires.
export const MENU_ACTION_CHANNEL = 'menu-action';

const send = (action: string) => () => {
    BrowserWindow.getFocusedWindow()?.webContents.send(MENU_ACTION_CHANNEL, action);
};

export function buildMacTemplate(): MenuItemConstructorOptions[] {
    return [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Settings\u2026', accelerator: 'CmdOrCtrl+,', click: send('settings') },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'Vault',
            submenu: [
                { label: 'Search', accelerator: 'CmdOrCtrl+F', click: send('search') },
                { label: 'New Entry', accelerator: 'CmdOrCtrl+N', click: send('newEntry') },
                { type: 'separator' },
                { label: 'Lock', accelerator: 'CmdOrCtrl+L', click: send('lock') },
            ],
        },
        {
            label: 'Entry',
            submenu: [
                { label: 'Edit', accelerator: 'CmdOrCtrl+E', click: send('edit') },
                { label: 'Move to Group\u2026', accelerator: 'CmdOrCtrl+M', click: send('move') },
                { type: 'separator' },
                { label: 'Copy Username', accelerator: 'CmdOrCtrl+B', click: send('copyUsername') },
                { label: 'Copy One-Time Code', accelerator: 'CmdOrCtrl+T', click: send('copyOtp') },
                { label: 'Open URL', accelerator: 'CmdOrCtrl+U', click: send('openUrl') },
            ],
        },
        {
            // Zoom only: no reload, no DevTools
            label: 'View',
            submenu: [
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' },
            ],
        },
        { role: 'windowMenu' },
    ];
}

export function applyApplicationMenu(): void {
    // Development keeps Electron's default menu, DevTools included
    if (!app.isPackaged) return;

    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
        return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacTemplate()));
}

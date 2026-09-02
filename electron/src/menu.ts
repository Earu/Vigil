import { Menu, app } from 'electron';

// Electron installs a default menu whenever the app sets none, and that menu
// carries View -> Toggle Developer Tools. In a packaged build that is a way
// straight past everything else here: DevTools on an unlocked vault reads
// every decrypted field out of the renderer, and the screen-capture
// protection does not apply because nothing is being captured. So a release
// build gets a menu with no View submenu at all, and no DevTools to reach.
//
// The menu cannot simply be dropped on macOS. AppKit routes Cmd+C/V/X/A/Z and
// Cmd+Q through the menu rather than the focused control, so
// setApplicationMenu(null) there costs the app every text-editing shortcut it
// has, in the search box and in every entry field. Windows and Linux take
// those from Chromium directly and need no menu at all, and their windows are
// frameless, so nothing is drawn either way.
export function applyApplicationMenu(): void {
    // Development keeps Electron's default menu, DevTools included
    if (!app.isPackaged) return;

    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
        return;
    }

    // The three roles a macOS app needs, minus View. appMenu carries Quit and
    // Hide, editMenu the clipboard and undo shortcuts, windowMenu Minimize
    // and Close
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
    ]));
}

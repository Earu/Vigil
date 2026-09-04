import { BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { isDevBuild } from './utils';
import { APP_HOST, APP_SCHEME } from './app-protocol';

// Every IPC handler runs behind this. The bridge is only ever handed to the
// document window.ts loads, and nothing else can reach it today (subframes
// get no preload, navigation is blocked, no other windows are created), so
// this decides nothing yet. It is here so that stays true by construction: a
// handler added later, or a window that one day loads something else, gets
// the check without anyone remembering to add it.
//
// What counts as Vigil's renderer: the main frame of a window this app
// created, showing the app's own document. Dev is the Vite origin; packaged
// builds are the index.html window.ts loads from the app scheme

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

const DEV_ORIGIN = 'http://localhost:5173';

function isTrustedDocument(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (isDevBuild()) return parsed.origin === DEV_ORIGIN;
    // Node's URL gives a non-special scheme no origin, so the parts are
    // compared one by one. Chromium hands over the canonical form (lowercase
    // scheme and host), the same one it served
    return parsed.protocol === `${APP_SCHEME}:`
        && parsed.hostname === APP_HOST
        && parsed.pathname === '/index.html';
}

export function isTrustedSender(event: IpcEvent): boolean {
    const frame = event.senderFrame;
    // Gone between the send and the handler; nothing to vouch for
    if (!frame) return false;
    // A frame inside the page is not the page
    if (frame !== event.sender.mainFrame) return false;
    // A webContents that is not one of this app's windows
    if (!BrowserWindow.fromWebContents(event.sender)) return false;
    return isTrustedDocument(frame.url);
}

// Drop-in for ipcMain.handle: an untrusted sender gets a rejection rather
// than the handler
export function handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) {
            console.warn(`Refused ${channel} from an untrusted sender: ${event.senderFrame?.url ?? '(no frame)'}`);
            throw new Error('Untrusted IPC sender');
        }
        return listener(event, ...args);
    });
}

// Drop-in for ipcMain.on: an untrusted sender's message is dropped
export function on(
    channel: string,
    listener: (event: IpcMainEvent, ...args: any[]) => void
): void {
    ipcMain.on(channel, (event, ...args) => {
        if (!isTrustedSender(event)) {
            console.warn(`Dropped ${channel} from an untrusted sender: ${event.senderFrame?.url ?? '(no frame)'}`);
            return;
        }
        listener(event, ...args);
    });
}

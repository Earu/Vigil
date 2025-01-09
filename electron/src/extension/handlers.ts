import { WebSocket } from 'ws';
import { BrowserWindow, ipcMain } from 'electron';
import { ExtensionMessage } from './types';

export function handleExtensionMessage(ws: WebSocket, connectionId: string, message: ExtensionMessage) {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Check authentication for all messages
    if (!global.trustedConnections?.has(connectionId)) {
        ws.send(JSON.stringify({
            error: 'Not authenticated',
            requestId: message.requestId
        }));
        return;
    }

    // Forward message to renderer
    mainWindow.webContents.send('extension-message', message);

    // Set up a one-time listener for the response if there's a requestId
    if (message.requestId) {
        const responseHandler = (_: any, response: any) => {
            ws.send(JSON.stringify({
                ...response,
                requestId: message.requestId
            }));
        };

        ipcMain.once(`extension-response-${message.requestId}`, responseHandler);

        setTimeout(() => {
            ipcMain.removeListener(`extension-response-${message.requestId}`, responseHandler);
        }, 60000);
    }
}

// IPC handlers for trust management
export function setupExtensionIpcHandlers() {
    ipcMain.handle('trust-connection', (_, connectionId: string) => {
        global.trustedConnections?.add(connectionId);
    });

    ipcMain.handle('untrust-connection', (_, connectionId: string) => {
        global.trustedConnections?.delete(connectionId);
    });
}
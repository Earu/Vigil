import { WebSocket } from 'ws';
import { BrowserWindow, ipcMain } from 'electron';
import { ExtensionMessage } from './types';
import { AuthenticationHandler } from './auth';

const authHandler = AuthenticationHandler.getInstance();

export function handleExtensionMessage(ws: WebSocket, connectionId: string, message: ExtensionMessage) {
    const appName = authHandler.getConnectionAppName(connectionId);
    if (!appName) {
        ws.send(JSON.stringify({
            error: 'Connection not authenticated',
            requestId: message.requestId
        }));
        return;
    }

    // Forward message to renderer
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow || mainWindow.isDestroyed()) {
        ws.send(JSON.stringify({
            error: 'Main window not available',
            requestId: message.requestId
        }));
        return;
    }

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
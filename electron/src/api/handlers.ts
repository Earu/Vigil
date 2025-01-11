import { Response } from 'express';
import { BrowserWindow, ipcMain } from 'electron';
import { ExtensionMessage } from './types';
import { AuthenticationHandler } from './auth';

const authHandler = AuthenticationHandler.getInstance();

export function handleExtensionMessage(res: Response, connectionId: string, message: ExtensionMessage) {
    const appName = authHandler.getConnectionAppName(connectionId);
    if (!appName) {
        res.status(401).json({
            error: 'Connection not authenticated',
            requestId: message.requestId
        });
        return;
    }

    // Forward message to renderer
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow || mainWindow.isDestroyed()) {
        res.status(503).json({
            error: 'Main window not available',
            requestId: message.requestId
        });
        return;
    }

    mainWindow.webContents.send('extension-message', message);

    // Set up a one-time listener for the response if there's a requestId
    if (message.requestId) {
        const responseHandler = (_: any, response: any) => {
            res.json({
                ...response,
                requestId: message.requestId
            });
        };

        ipcMain.once(`extension-response-${message.requestId}`, responseHandler);

        // Clean up the listener after timeout
        setTimeout(() => {
            const listenerCount = ipcMain.listenerCount(`extension-response-${message.requestId}`);
            if (listenerCount > 0) {
                ipcMain.removeListener(`extension-response-${message.requestId}`, responseHandler);
                if (!res.headersSent) {
                    res.status(504).json({
                        error: 'Request timed out',
                        requestId: message.requestId
                    });
                }
            }
        }, 60000);
    } else {
        res.status(200).end();
    }
}
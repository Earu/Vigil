import { WebSocket, WebSocketServer } from 'ws';
import { BrowserWindow } from 'electron';
import { handleExtensionMessage } from './handlers';
import { ExtensionMessage } from './types';

// Initialize connection tracking
global.trustedConnections = new Set();
global.wsConnections = new Map();
global.pendingAuth = null;

function bringWindowToFront(mainWindow: BrowserWindow) {
    if (!mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
        mainWindow.setAlwaysOnTop(true);
        mainWindow.show();
        mainWindow.focus();
        // Reset always on top after a short delay
        setTimeout(() => {
            mainWindow.setAlwaysOnTop(false);
        }, 100);
    }
}

function handleNewConnection(ws: WebSocket) {
    console.log('Browser extension connected');

    // Check if we're currently authenticating another connection
    if (global.pendingAuth !== null) {
        console.log('Rejecting connection: authentication in progress with another client');
        ws.send(JSON.stringify({
            error: 'Another client is currently authenticating'
        }));
        ws.close();
        return;
    }

    const connectionId = `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    global.wsConnections.set(connectionId, ws);
    global.pendingAuth = connectionId;

    // Request authentication immediately on connection
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Requesting authentication');
        mainWindow.webContents.send('request-authentication', {
            requestId: `auth-${connectionId}`,
            connectionId: connectionId
        });

        bringWindowToFront(mainWindow);

        // Set up a listener for when the connection becomes trusted
        const checkTrusted = setInterval(() => {
            if (global.trustedConnections?.has(connectionId)) {
                clearInterval(checkTrusted);
                global.pendingAuth = null;
                ws.send(JSON.stringify({
                    type: 'ready'
                }));
            }
        }, 100);

        // Clean up after timeout
        setTimeout(() => {
            clearInterval(checkTrusted);
            if (global.pendingAuth === connectionId) {
                global.pendingAuth = null;
                ws.send(JSON.stringify({
                    error: 'Authentication timed out'
                }));
                ws.close();
            }
        }, 60000);
    }

    ws.on('message', (message: string) => {
        try {
            const data = JSON.parse(message.toString()) as ExtensionMessage;
            handleExtensionMessage(ws, connectionId, data);
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            try {
                const data = JSON.parse(message.toString());
                if (data?.requestId) {
                    ws.send(JSON.stringify({
                        error: 'Internal server error',
                        requestId: data.requestId
                    }));
                }
            } catch {
                console.error('Could not send error response');
            }
        }
    });

    ws.on('close', () => {
        console.log('Browser extension disconnected');
        // Clean up connection tracking
        global.trustedConnections?.delete(connectionId);
        global.wsConnections.delete(connectionId);
        // Clear pending auth if this was the authenticating connection
        if (global.pendingAuth === connectionId) {
            global.pendingAuth = null;
        }
    });
}

export function setupWebSocketServer() {
    const wss = new WebSocketServer({ port: 8437 });
    wss.on('connection', handleNewConnection);
    return wss;
}
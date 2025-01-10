import { WebSocket, WebSocketServer } from 'ws';
import { ipcMain } from 'electron';
import { handleExtensionMessage } from './handlers';
import { ExtensionMessage, AuthenticationMessage } from './types';
import { AuthenticationHandler } from './auth';

// Initialize authentication handler
const authHandler = AuthenticationHandler.getInstance();

// Set up IPC handler for database path updates
ipcMain.handle('set-database-path', (_, path: string | null) => {
    authHandler.setDatabasePath(path);
});

// Set up IPC handlers for authentication
ipcMain.handle('trust-connection', (_, connectionId: string) => {
    authHandler.handleAuthenticationSuccess(connectionId);
});

ipcMain.handle('untrust-connection', (_, connectionId: string) => {
    authHandler.handleAuthenticationFailure(connectionId);
});

function handleNewConnection(ws: WebSocket) {
    console.log('Browser extension connected');
    const connectionId = `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    ws.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message.toString());

            // Handle authentication message
            if (data.type === 'authenticate') {
                await authHandler.handleAuthentication(ws, connectionId, data as AuthenticationMessage);
                return;
            }

            // All other messages require authentication
            if (!authHandler.isConnectionTrusted(connectionId)) {
                ws.send(JSON.stringify({
                    error: 'Not authenticated',
                    requestId: data.requestId
                }));
                return;
            }

            handleExtensionMessage(ws, connectionId, data as ExtensionMessage);
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
        authHandler.removeConnection(connectionId);
    });
}

export function setupWebSocketServer() {
    const wss = new WebSocketServer({ port: 8437 });
    wss.on('connection', handleNewConnection);
    return wss;
}
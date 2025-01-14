import express from 'express';
import cors from 'cors';
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

export function setupHttpServer() {
    const app = express();
    app.use(express.json());
    app.use(cors());

    // Only allow requests from localhost
    app.use((req, res, next) => {
        const clientIp = req.socket.remoteAddress;
        if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
            next();
        } else {
            res.status(403).json({ error: 'Access denied - only localhost connections are allowed' });
        }
    });

    // Authentication endpoint
    app.post('/auth', async (req, res) => {
        const connectionId = `http-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        try {
            await authHandler.handleAuthentication(res, connectionId, req.body as AuthenticationMessage);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Message endpoint for authenticated requests
    app.post('/message', async (req, res) => {
        const connectionId = req.headers['x-connection-id'] as string;
        if (!connectionId || !authHandler.isConnectionTrusted(connectionId)) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        try {
            await handleExtensionMessage(res, connectionId, req.body as ExtensionMessage);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Health check endpoint
    app.get('/health', (_, res) => {
        res.json({ status: 'ok' });
    });

    const server = app.listen(45731, () => {
        console.log('API server started');
    });

    return server;
}
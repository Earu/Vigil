import { WebSocket } from 'ws';
import { BrowserWindow } from 'electron';
import { validateSecret, generateSecret } from './secrets';
import { AuthenticationMessage } from './types';
import EventEmitter from 'events';

interface AuthenticationRequest {
    connectionId: string;
    appName: string;
    ws: WebSocket;
    timeoutId: NodeJS.Timeout;
}

export class AuthenticationHandler extends EventEmitter {
    private static instance: AuthenticationHandler;
    private currentDatabasePath: string | null = null;
    private trustedConnections = new Set<string>();
    private connectionAppNames = new Map<string, string>();
    private pendingAuth: AuthenticationRequest | null = null;

    private constructor() {
        super();
    }

    static getInstance(): AuthenticationHandler {
        if (!AuthenticationHandler.instance) {
            AuthenticationHandler.instance = new AuthenticationHandler();
        }
        return AuthenticationHandler.instance;
    }

    setDatabasePath(path: string | null) {
        this.currentDatabasePath = path;
        if (!path) {
            // Clear all trusted connections when database is closed
            this.trustedConnections.clear();
            this.connectionAppNames.clear();
        }
    }

    isConnectionTrusted(connectionId: string): boolean {
        return this.trustedConnections.has(connectionId);
    }

    getConnectionAppName(connectionId: string): string | undefined {
        return this.connectionAppNames.get(connectionId);
    }

    removeConnection(connectionId: string) {
        this.trustedConnections.delete(connectionId);
        this.connectionAppNames.delete(connectionId);
        if (this.pendingAuth?.connectionId === connectionId) {
            this.clearPendingAuth();
        }
    }

    private clearPendingAuth() {
        if (this.pendingAuth) {
            clearTimeout(this.pendingAuth.timeoutId);
            this.pendingAuth = null;
        }
    }

    private async handleSecretValidation(
        ws: WebSocket,
        connectionId: string,
        message: AuthenticationMessage
    ): Promise<boolean> {
        if (!message.secret || !this.currentDatabasePath) {
            return false;
        }

        const validation = await validateSecret(message.secret, this.currentDatabasePath);
        if (validation.valid && validation.appName) {
            this.trustedConnections.add(connectionId);
            this.connectionAppNames.set(connectionId, validation.appName);
            ws.send(JSON.stringify({
                type: 'ready'
            }));
            return true;
        }

        return false;
    }

    private setupAuthenticationTimeout(request: AuthenticationRequest) {
        return setTimeout(() => {
            if (this.pendingAuth?.connectionId === request.connectionId) {
                this.clearPendingAuth();
                request.ws.send(JSON.stringify({
                    error: 'Authentication timed out'
                }));
                request.ws.close();
            }
        }, 60000); // 1 minute timeout
    }

    async handleAuthentication(
        ws: WebSocket,
        connectionId: string,
        message: AuthenticationMessage
    ): Promise<void> {
        try {
            // Check if database is open
            if (!this.currentDatabasePath) {
                ws.send(JSON.stringify({
                    error: 'No database is currently open'
                }));
                return;
            }

            // Try to validate existing secret
            if (await this.handleSecretValidation(ws, connectionId, message)) {
                return;
            }

            // Check if another authentication is in progress
            if (this.pendingAuth) {
                ws.send(JSON.stringify({
                    error: 'Another client is currently authenticating'
                }));
                ws.close();
                return;
            }

            // Set up new authentication request
            const timeoutId = this.setupAuthenticationTimeout({ ws, connectionId, appName: message.appName, timeoutId: null! });
            this.pendingAuth = { ws, connectionId, appName: message.appName, timeoutId };

            // Request authentication from the main window
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow || mainWindow.isDestroyed()) {
                throw new Error('Main window not available');
            }

            mainWindow.webContents.send('request-authentication', {
                requestId: `auth-${connectionId}`,
                connectionId,
                appName: message.appName
            });

            // Bring window to front
            if (!mainWindow.isFocused()) {
                mainWindow.flashFrame(true);
                mainWindow.setAlwaysOnTop(true);
                mainWindow.show();
                mainWindow.focus();
                setTimeout(() => mainWindow.setAlwaysOnTop(false), 100);
            }

        } catch (error) {
            console.error('Authentication error:', error);
            ws.send(JSON.stringify({
                error: 'Internal authentication error'
            }));
            ws.close();
        }
    }

    async handleAuthenticationSuccess(connectionId: string): Promise<void> {
        if (!this.pendingAuth || this.pendingAuth.connectionId !== connectionId) {
            return;
        }

        try {
            const { ws, appName } = this.pendingAuth;
            this.trustedConnections.add(connectionId);
            this.connectionAppNames.set(connectionId, appName);

            if (this.currentDatabasePath) {
                const secret = await generateSecret(appName, this.currentDatabasePath);
                ws.send(JSON.stringify({
                    type: 'ready',
                    data: {
                        secret,
                        dbPath: this.currentDatabasePath
                    }
                }));
            }
        } finally {
            this.clearPendingAuth();
        }
    }

    async handleAuthenticationFailure(connectionId: string): Promise<void> {
        if (!this.pendingAuth || this.pendingAuth.connectionId !== connectionId) {
            return;
        }

        try {
            this.pendingAuth.ws.send(JSON.stringify({
                error: 'Authentication denied by user'
            }));
            this.pendingAuth.ws.close();
        } finally {
            this.clearPendingAuth();
        }
    }
}
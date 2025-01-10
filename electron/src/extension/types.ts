import { WebSocket } from 'ws';

export interface ExtensionMessage {
    type: string;
    data?: any;
    requestId?: string;
    error?: string;
}

export interface AuthenticationMessage {
    type: 'authenticate';
    appName: string;
    secret?: string;
}

export interface Secret {
    timeCreated: number;
    appName: string;
    dbPath: string;
}

declare global {
    namespace NodeJS {
        interface Global {
            trustedConnections: Set<string>;
            wsConnections: Map<string, WebSocket>;
            pendingAuth: string | null;
            connectionAppNames: Map<string, string>;
        }
    }
}
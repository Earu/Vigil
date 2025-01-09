import { WebSocket } from 'ws';

export interface ExtensionMessage {
    type: string;
    data?: any;
    requestId?: string;
    error?: string;
}

declare global {
    namespace NodeJS {
        interface Global {
            trustedConnections: Set<string>;
            wsConnections: Map<string, WebSocket>;
            pendingAuth: string | null;
        }
    }
}
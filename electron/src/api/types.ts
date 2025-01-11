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
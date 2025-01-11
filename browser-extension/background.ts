import { Credentials, MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';
import { v4 as uuidv4 } from 'uuid';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: ReturnType<typeof setTimeout>;
}

interface StoredSecret {
    secret: string;
    timeCreated: number;
    dbPath: string;
}

const APP_NAME = 'Vigil Browser Extension';
const pendingRequests = new Map<string, PendingRequest>();
let ws: WebSocket | null = null;
let isAuthenticated = false;
let currentDbPath: string | null = null;

// Cache for available entries
interface CachedEntry {
    id: string;
    url: string;
    username: string;
    title: string;
}

let entriesCache: CachedEntry[] = [];

// Add an enum for connection states
enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    PermanentlyDisconnected
}

let connectionState = ConnectionState.Disconnected;
const RECONNECTABLE_ERRORS = [
    'No database is currently open',
    'Another client is currently authenticating',
    'Main window not available'
];

async function getStoredSecret(): Promise<StoredSecret | null> {
    try {
        const result = await browserAPI.storage.local.get('secret');
        if (!result.secret) return null;

        // Validate the secret hasn't expired
        const secret = result.secret as StoredSecret;
        const now = Date.now();
        if (now - secret.timeCreated > 24 * 60 * 60 * 1000) { // 24 hours
            await clearStoredSecret();
            return null;
        }

        return secret;
    } catch (error) {
        logger.error('background', 'Error getting stored secret:', error);
        return null;
    }
}

async function storeSecret(secret: string, dbPath: string): Promise<void> {
    try {
        await browserAPI.storage.local.set({
            secret: {
                secret,
                timeCreated: Date.now(),
                dbPath
            }
        });
        currentDbPath = dbPath;
    } catch (error) {
        logger.error('background', 'Error storing secret:', error);
    }
}

async function clearStoredSecret(): Promise<void> {
    try {
        await browserAPI.storage.local.remove('secret');
        currentDbPath = null;
    } catch (error) {
        logger.error('background', 'Error clearing stored secret:', error);
    }
}

function cleanupRequest(requestId: string) {
    const request = pendingRequests.get(requestId);
    if (request) {
        clearTimeout(request.timeout);
        pendingRequests.delete(requestId);
    }
}

function sendRequest(type: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not connected'));
            return;
        }

        if (!isAuthenticated) {
            reject(new Error('Not authenticated'));
            return;
        }

        const requestId = uuidv4();
        const timeout = setTimeout(() => {
            cleanupRequest(requestId);
            reject(new Error('Request timed out'));
        }, 60000); // 1 minute timeout

        pendingRequests.set(requestId, {
            resolve,
            reject,
            timeout
        });

        ws.send(JSON.stringify({
            type,
            data,
            requestId
        }));
    });
}

async function authenticate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not connected');
    }

    const storedSecret = await getStoredSecret();
    const authMessage = {
        type: 'authenticate',
        appName: APP_NAME,
        secret: storedSecret?.secret
    };

    return new Promise<void>((resolve, reject) => {
        if (!ws) {
            reject(new Error('WebSocket not connected'));
            return;
        }

        const requestId = uuidv4();
        const timeout = setTimeout(() => {
            cleanupRequest(requestId);
            reject(new Error('Authentication timed out'));
        }, 60000);

        pendingRequests.set(requestId, {
            resolve,
            reject,
            timeout
        });

        ws.send(JSON.stringify(authMessage));
    });
}

// Function to broadcast connection state changes
function broadcastConnectionState(state: ConnectionState) {
    browserAPI.runtime.sendMessage({
        type: 'CONNECTION_STATE_CHANGED',
        state: state
    }).catch(() => {
        // Ignore errors - popup might not be open
    });
}

// Handle connection state requests
browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: any) => void
) => {
    logger.debug('background', 'Received message');

    if (request.type === 'GET_CONNECTION_STATE') {
        sendResponse(connectionState);
        return true;
    }

    if (request.type === 'GET_ALL_ENTRIES') {
        sendResponse(entriesCache);
        return true;
    }

    if (request.type === 'GET_AVAILABLE_ENTRIES') {
        if (!request.domain) {
            sendResponse([]);
            return true;
        }

        const requestDomain = request.domain.toLowerCase();

        // Filter entries based on domain and sort by match score
        const matchingEntries = entriesCache
            .map(entry => {
                const score = findBestMatchingEntry(requestDomain, [entry]) ? 1 : 0;
                return { entry, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ entry }) => entry);

        sendResponse(matchingEntries);
        return true;
    }

    if (request.type === 'GET_CREDENTIALS') {
        logger.debug('background', 'Getting credentials:', request.entryIndex);

        if (typeof request.entryIndex !== 'number') {
            sendResponse({ success: false, error: 'Invalid request parameters' });
            return true;
        }

        const entry = entriesCache[request.entryIndex];
        if (!entry) {
            sendResponse({ success: false, error: 'Entry not found' });
            return true;
        }

        // If this is from the search modal and the entry doesn't have a URL yet,
        // associate the current domain with it
        if (request.domain && !entry.url) {
            entry.url = `https://${request.domain}`;
            // Update the entry in the Vigil app
            sendRequest('UPDATE_ENTRY', {
                id: entry.id,
                url: entry.url
            }).catch((error) => {
                logger.error('background', 'Error updating entry URL:', error);
            });
        }

        // Send request to Vigil app through WebSocket
        sendRequest('GET_CREDENTIALS', { id: entry.id })
            .then((credentials) => {
                credentials.username = entry.username;
                sendResponse({ success: true, ...credentials });
            })
            .catch((error) => {
                logger.error('background', 'Error getting credentials:', error);
                sendResponse({ success: false, error: error.message });
            });

        return true; // Will respond asynchronously
    }

    return true;
});

function setupWebSocket() {
    if (ws) {
        ws.close();
    }

    if (connectionState === ConnectionState.PermanentlyDisconnected) {
        broadcastConnectionState(connectionState);
        return;
    }

    connectionState = ConnectionState.Connecting;
    broadcastConnectionState(connectionState);

    ws = new WebSocket('ws://localhost:8437');
    isAuthenticated = false;

    ws.onopen = () => {
        logger.debug('background', 'Connected to Vigil app');
        authenticate().catch((error) => {
            logger.error('background', 'Authentication failed:', error);
            if (!RECONNECTABLE_ERRORS.includes(error.message)) {
                connectionState = ConnectionState.PermanentlyDisconnected;
                broadcastConnectionState(connectionState);
            }
        });
    };

    ws.onclose = () => {
        logger.debug('background', 'Disconnected from Vigil app');
        isAuthenticated = false;
        currentDbPath = null;

        for (const [requestId, request] of pendingRequests.entries()) {
            request.reject(new Error('Connection closed'));
            cleanupRequest(requestId);
        }

        if (connectionState !== ConnectionState.PermanentlyDisconnected) {
            connectionState = ConnectionState.Disconnected;
            broadcastConnectionState(connectionState);
            setTimeout(setupWebSocket, 5000);
        }
    };

    ws.onerror = (error) => {
        logger.error('background', 'WebSocket error:', error);
    };

    ws.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);
            logger.debug('background', 'Received message from Vigil app');

            if (message.type === 'ready') {
                connectionState = ConnectionState.Connected;
                broadcastConnectionState(connectionState);
                isAuthenticated = true;

                // Clean up any pending authentication request
                for (const [requestId, request] of pendingRequests.entries()) {
                    if (request) {
                        request.resolve(undefined);
                        cleanupRequest(requestId);
                    }
                }

                if (message.data?.secret && message.data?.dbPath) {
                    await storeSecret(message.data.secret, message.data.dbPath);
                }

                sendRequest('GET_AVAILABLE_ENTRIES', {})
                    .then((response) => {
                        entriesCache = response;
                        logger.debug('background', 'Available entries cached:', response);
                    })
                    .catch((error) => {
                        logger.error('background', 'Error getting available entries:', error);
                    });
                return;
            }

            // Handle authentication errors
            if (message.error) {
                const shouldReconnect = RECONNECTABLE_ERRORS.includes(message.error);

                if (message.error === 'Authentication denied by user') {
                    connectionState = ConnectionState.PermanentlyDisconnected;
                    await clearStoredSecret();
                } else if (message.error === 'Not authenticated' ||
                         message.error === 'Authentication failed' ||
                         message.error === 'No database is currently open') {
                    isAuthenticated = false;
                    await clearStoredSecret();
                    if (!shouldReconnect) {
                        connectionState = ConnectionState.PermanentlyDisconnected;
                    } else {
                        resetConnectionState();
                    }
                }

                // If we're permanently disconnected, close the connection
                if (connectionState === ConnectionState.PermanentlyDisconnected) {
                    ws?.close();
                }
            }

            if (message.requestId) {
                const request = pendingRequests.get(message.requestId);
                if (request) {
                    if (message.error) {
                        request.reject(new Error(message.error));
                    } else {
                        request.resolve(message.data);
                    }
                    cleanupRequest(message.requestId);
                }
            }
        } catch (error) {
            logger.error('background', 'Error processing message:', error);
        }
    };
}

// Add a function to reset the connection state
function resetConnectionState() {
    connectionState = ConnectionState.Disconnected;
    setupWebSocket();
}

// Initial WebSocket setup
setupWebSocket();

function getDomainFromUrl(url: string): string | null {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname.toLowerCase();
    } catch {
        return null;
    }
}

function extractDomainKeywords(domain: string): string[] {
    // Remove common TLDs and www
    return domain
        .replace(/^www\./, '')
        .replace(/\.(com|org|net|edu|gov|mil|io|co|uk|de|fr|it|nl|eu)$/, '')
        .split('.');
}

function findBestMatchingEntry(domain: string, entries: CachedEntry[]): CachedEntry | null {
    if (!domain) return null;

    const requestDomain = domain.toLowerCase();
    const requestKeywords = extractDomainKeywords(requestDomain);

    let bestMatch: { entry: CachedEntry, score: number } | null = null;

    for (const entry of entries) {
        let score = 0;

        // Check URL match
        if (entry.url) {
            const entryDomain = getDomainFromUrl(entry.url);
            if (entryDomain) {
                if (entryDomain === requestDomain) {
                    score += 100; // Exact domain match is highest priority
                } else {
                    // Check for subdomain matches
                    if (requestDomain.endsWith(`.${entryDomain}`) || entryDomain.endsWith(`.${requestDomain}`)) {
                        score += 50;
                    }
                }
            }
        }

        // Check title match with domain keywords
        if (entry.title) {
            const titleLower = entry.title.toLowerCase();
            for (const keyword of requestKeywords) {
                if (titleLower.includes(keyword)) {
                    score += 25;
                }
            }
        }

        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { entry, score };
        }
    }

    return bestMatch ? bestMatch.entry : null;
}

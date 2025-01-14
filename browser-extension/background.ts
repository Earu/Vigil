/// <reference lib="webworker" />
import { MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';
import { v4 as uuidv4 } from 'uuid';

declare const self: ServiceWorkerGlobalScope;

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
const API_BASE_URL = 'http://localhost:45731';
const pendingRequests = new Map<string, PendingRequest>();
let connectionId: string | null = null;
let isAuthenticated = false;

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
    } catch (error) {
        logger.error('background', 'Error storing secret:', error);
    }
}

async function clearStoredSecret(): Promise<void> {
    try {
        await browserAPI.storage.local.remove('secret');
        connectionId = null;
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

async function sendRequest(type: string, data: any): Promise<any> {
    if (!isAuthenticated || !connectionId) {
        throw new Error('Not authenticated');
    }

    const requestId = uuidv4();
    const timeout = setTimeout(() => {
        cleanupRequest(requestId);
        throw new Error('Request timed out');
    }, 60000);

    try {
        const response = await fetch(`${API_BASE_URL}/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Connection-Id': connectionId
            },
            body: JSON.stringify({
                type,
                data,
                requestId
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Request failed');
        }

        const result = await response.json();
        if (result.error) {
            throw new Error(result.error);
        }

        return result.data;
    } finally {
        cleanupRequest(requestId);
    }
}

async function authenticate() {
    connectionState = ConnectionState.Connecting;
    broadcastConnectionState(connectionState);

    try {
        const storedSecret = await getStoredSecret();
        const response = await fetch(`${API_BASE_URL}/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'authenticate',
                appName: APP_NAME,
                secret: storedSecret?.secret
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Authentication failed');
        }

        if (result.type === 'ready') {
            connectionState = ConnectionState.Connected;
            isAuthenticated = true;
            connectionId = result.data?.connectionId || result.connectionId;

            if (result.data?.secret && result.data?.dbPath) {
                await storeSecret(result.data.secret, result.data.dbPath);
            }

            // Get available entries after successful authentication
            try {
                entriesCache = await sendRequest('GET_AVAILABLE_ENTRIES', {});
                logger.debug('background', 'Available entries cached:', entriesCache);
            } catch (error) {
                logger.error('background', 'Error getting available entries:', error);
            }
        }
    } catch (err: any) {
        logger.error('background', 'Authentication failed:', err);
        const errorMessage = err.message || 'Authentication failed';

        if (errorMessage === 'Authentication denied by user') {
            connectionState = ConnectionState.PermanentlyDisconnected;
            await clearStoredSecret();
        } else if (
            errorMessage === 'Not authenticated' ||
            errorMessage === 'Authentication failed' ||
            errorMessage === 'No database is currently open'
        ) {
            isAuthenticated = false;
            await clearStoredSecret();
            if (!RECONNECTABLE_ERRORS.includes(errorMessage)) {
                connectionState = ConnectionState.PermanentlyDisconnected;
            } else {
                resetConnectionState();
            }
        }

        throw err;
    } finally {
        broadcastConnectionState(connectionState);
    }
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

// Service Worker lifecycle events
self.addEventListener('install', (event: ExtendableEvent) => {
    logger.debug('background', 'Service Worker installed');
    // Skip waiting to activate the service worker immediately
    self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
    logger.debug('background', 'Service Worker activated');
    // Claim all clients to ensure the service worker controls all tabs
    event.waitUntil(self.clients.claim());
});

// Message handling through runtime.onMessage
browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: any) => void
) => {
    logger.debug('background', 'Received message through runtime');

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
        const matchingEntries = findBestMatchingEntries(requestDomain, entriesCache);
        sendResponse(matchingEntries);
        return true;
    }

    if (request.type === 'GET_CREDENTIALS') {
        logger.debug('background', 'Getting credentials:', request.entryIndex);

        if (typeof request.entryIndex !== 'number') {
            sendResponse({ success: false, error: 'Invalid request parameters' });
            return true;
        }

        // Use the filtered entries if provided, otherwise use the full cache
        const entries = request.filteredEntries || entriesCache;
        const entry = entries[request.entryIndex];
        if (!entry) {
            sendResponse({ success: false, error: 'Entry not found' });
            return true;
        }

        // If this doesn't have a URL yet, associate the current domain with it
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

        // Send request to Vigil app
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

// Helper functions for domain matching
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
    const keywords = domain
        .replace(/^www\./, '')
        .replace(/\.(com|org|net|edu|gov|mil|io|co|uk|de|fr|it|nl|eu)$/, '')
        .split('.');

    // Filter out keywords that are too short (less than 2 characters)
    return keywords.filter(keyword => keyword.length > 3);
}

function findBestMatchingEntries(domain: string, entries: CachedEntry[]): CachedEntry[] {
    if (!domain) return [];

    const requestDomain = domain.toLowerCase();
    const requestKeywords = extractDomainKeywords(requestDomain);

    const matches: { entry: CachedEntry, score: number }[] = [];

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

        if (entry.title) {
            const titleLower = entry.title.toLowerCase();
            for (const keyword of requestKeywords) {
                if (titleLower.includes(keyword) || keyword.includes(titleLower)) {
                    score += 25;
                }
            }
        }

        if (score > 0) {
            matches.push({ entry, score });
        }
    }

    // Sort matches by score in descending order and take top 3
    return matches
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(match => match.entry);
}

// Function to check server health
async function checkServerHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${API_BASE_URL}/health`);
        const result = await response.json();
        return result.status === 'ok';
    } catch {
        return false;
    }
}

// Add a function to reset the connection state
async function resetConnectionState() {
    connectionState = ConnectionState.Disconnected;
    isAuthenticated = false;

    // Check if server is available before attempting to authenticate
    if (await checkServerHealth()) {
        try {
            await authenticate();
        } catch (error) {
            logger.error('background', 'Failed to authenticate:', error);
            setTimeout(resetConnectionState, 5000);
        }
    } else {
        setTimeout(resetConnectionState, 5000);
    }
}

// Initial connection setup
resetConnectionState();

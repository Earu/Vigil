import { Credentials, MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';
import { v4 as uuidv4 } from 'uuid';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();
let ws: WebSocket | null = null;
let isAuthenticated = false;

// Cache for available entries
interface CachedEntry {
    id: string;
    url: string;
    username: string;
    title: string;
}

let entriesCache: CachedEntry[] = [];
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

function setupWebSocket() {
    if (ws) {
        ws.close();
    }

    ws = new WebSocket('ws://localhost:8437');
    isAuthenticated = false;

    ws.onopen = () => {
        logger.debug('background', 'Connected to Vigil app');
    };

    ws.onclose = () => {
        logger.debug('background', 'Disconnected from Vigil app');
        isAuthenticated = false;

        // Clear all pending requests when connection is lost
        for (const [requestId, request] of pendingRequests.entries()) {
            request.reject(new Error('Connection closed'));
            cleanupRequest(requestId);
        }

        // Try to reconnect after 5 seconds
        setTimeout(setupWebSocket, 5000);
    };

    ws.onerror = (error) => {
        logger.error('background', 'WebSocket error:', error);
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            logger.debug('background', 'Received message from Vigil app:', message);

            if (message.type === 'ready') {
                isAuthenticated = true;
                // Initial request for available entries
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

            if (message.error === 'Not authenticated' || message.error === 'Authentication failed' || message.error === 'Authentication denied by user') {
                isAuthenticated = false;
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

browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: Credentials) => void
) => {
    logger.debug('background', 'Received message:', request);

    if (request.type === 'GET_CREDENTIALS') {
        logger.debug('background', 'Getting credentials for domain:', request.domain);

        if (!request.domain) {
            sendResponse({ success: false, error: 'No domain provided' });
            return true;
        }

        // Find best matching entry from cache based on domain
        const matchingEntry = findBestMatchingEntry(request.domain, entriesCache);
        if (!matchingEntry) {
            sendResponse({ success: false, error: 'No matching credentials found' });
            return true;
        }

        // Send request to Vigil app through WebSocket with timeout and ID
        sendRequest('GET_CREDENTIALS', { id: matchingEntry.id })
            .then((credentials) => {
                credentials.username = matchingEntry.username;
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

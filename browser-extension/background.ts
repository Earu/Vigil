import { Credentials, MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;
let ws: WebSocket | null = null;
let isAuthenticated = false;

function generateRequestId(): string {
    requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER;
    return `${Date.now()}-${requestCounter}`;
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

        const requestId = generateRequestId();
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
                        logger.debug('background', 'Available entries:', response);
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

browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: Credentials) => void
) => {
    logger.debug('background', 'Received message:', request);

    if (request.type === 'GET_CREDENTIALS' && request.id) {
        logger.debug('background', 'Getting credentials for entry:', request.id);

        // Send request to Vigil app through WebSocket with timeout and ID
        sendRequest('GET_CREDENTIALS', { id: request.id })
            .then((credentials) => {
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

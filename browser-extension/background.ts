import { Credentials, MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';

const HOST_NAME = 'com.vigil.password_manager';
let port: any = null;
const callbacks = new Map<string, (response: any) => void>();

function connectNativeHost() {
    try {
        logger.debug('background', 'Connecting to native host...');
        port = browserAPI.runtime.connectNative(HOST_NAME);
        
        port.onMessage.addListener((response: any) => {
            logger.debug('background', 'Received native message:', response);
            
            // Basic sanity check for timestamp
            if (!verifyMessage(response)) {
                logger.error('background', 'Invalid message received');
                return;
            }
            
            // Process the response
            processResponse(response);
        });
        
        port.onDisconnect.addListener(() => {
            const error = browserAPI.runtime.lastError;
            logger.error('background', 'Disconnected from native host:', error?.message);
            port = null;
            
            // Attempt to reconnect after a delay
            setTimeout(connectNativeHost, 5000);
        });

        logger.debug('background', 'Successfully connected to native host');
    } catch (error) {
        logger.error('background', 'Failed to connect to native host:', error);
        port = null;
    }
}

function verifyMessage(message: any): boolean {
    try {
        const now = Date.now();
        if (Math.abs(now - message.timestamp) > 5 * 60 * 1000) {
            return false;
        }
        return true;
    } catch (error) {
        return false;
    }
}

function processResponse(response: any) {
    if (response.nonce && callbacks.has(response.nonce)) {
        const callback = callbacks.get(response.nonce);
        callback?.(response.data);
        callbacks.delete(response.nonce);
    } else {
        logger.warn('background', 'Received response with no matching callback:', response);
    }
}

async function sendNativeMessage(action: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!port) {
            logger.debug('background', 'Port not connected, attempting to connect...');
            connectNativeHost();
        }
        
        if (!port) {
            reject(new Error('Failed to connect to native host'));
            return;
        }
        
        try {
            const nonce = Math.random().toString(36).substring(2);
            const message = {
                nonce,
                timestamp: Date.now(),
                action,
                data
            };
            
            logger.debug('background', 'Sending native message:', message);
            
            // Store callback before sending message
            callbacks.set(nonce, resolve);
            
            port.postMessage(message);
            
            // Add timeout to prevent hanging
            setTimeout(() => {
                if (callbacks.has(nonce)) {
                    callbacks.delete(nonce);
                    reject(new Error('Native messaging response timeout'));
                }
            }, 30000);
        } catch (error) {
            logger.error('background', 'Error sending native message:', error);
            reject(error);
        }
    });
}

browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: Credentials) => void
) => {
    logger.debug('background', 'Received message:', request);
    
    if (request.type === 'GET_CREDENTIALS') {
        logger.debug('background', 'Getting credentials for domain:', request.domain);
        
        sendNativeMessage('GET_CREDENTIALS', { domain: request.domain })
            .then((credentials: Credentials) => {
                logger.debug('background', 'Received credentials from native host');
                sendResponse(credentials);
            })
            .catch((error) => {
                logger.error('background', 'Error getting credentials:', error);
                sendResponse({
                    username: '',
                    password: '',
                    email: ''
                });
            });
        
        return true;
    }
    
    return true;
});

// Initialize connection
connectNativeHost();

logger.debug('background', 'Background script initialized'); 
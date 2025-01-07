import { Credentials, MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';

browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: Credentials) => void
) => {
    logger.info('background', 'Received message:', request);
    logger.info('background', 'Sender:', sender);

    if (request.type === 'GET_CREDENTIALS') {
        logger.debug('background', 'Getting credentials for domain:', request.domain);
        
        // Here you would implement communication with your main app
        const mockCredentials: Credentials = {
            username: 'stored_username',
            password: 'stored_password',
            email: 'stored_email@example.com'
        };
        
        logger.debug('background', 'Sending credentials:', mockCredentials);
        sendResponse(mockCredentials);
    }
    
    return true;
});

logger.info('background', 'Background script initialized'); 
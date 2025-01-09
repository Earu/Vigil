import { Credentials, MessageRequest } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';

browserAPI.runtime.onMessage.addListener((
    request: MessageRequest,
    sender: any,
    sendResponse: (response: Credentials) => void
) => {
    logger.debug('background', 'Received message:', request);

    if (request.type === 'GET_CREDENTIALS') {
        logger.debug('background', 'Getting credentials for domain:', request.domain);

        return true;
    }

    return true;
});

import { Credentials, FormFields } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';

function isElementVisible(element: HTMLInputElement): boolean {
    // Check if element is disabled or explicitly hidden
    if (element.disabled || element.style.display === 'none' || element.style.visibility === 'hidden') {
        return false;
    }

    // Get element dimensions and position
    const rect = element.getBoundingClientRect();
    
    // Check if element has size and is not hidden by zero dimensions
    if (rect.width === 0 || rect.height === 0) {
        return false;
    }

    // Check if element or its ancestors have opacity 0
    let currentElement: HTMLElement | null = element;
    while (currentElement) {
        const opacity = window.getComputedStyle(currentElement).opacity;
        if (opacity === '0') {
            return false;
        }
        currentElement = currentElement.parentElement;
    }

    return true;
}

function detectFormFields(): FormFields {
    const inputs = document.querySelectorAll('input');
    logger.debug('content', 'Detecting form fields, found inputs:', inputs.length);
    
    const formFields: FormFields = {
        passwords: [],
        usernames: [],
    };

    for (const input of inputs) {
        if (!isElementVisible(input)) {
            continue;
        }

        if (input.type === 'password') {
            formFields.passwords.push(input);
            logger.debug('content', 'Found password field:', input);
        } else if (input.type === 'text' || input.type === 'email') {
            const fields = ['email', 'user', 'login'];
            const inputFields = [input.name, input.id, input.placeholder, input.autocomplete];

            for (const inputField of inputFields) {
                if (fields.includes(inputField.toLowerCase())) {
                    formFields.usernames.push(input);  
                    logger.debug('content', 'Found username field:', input);
                    break;     
                }
            }
        }
    }

    return formFields;
}

function getCurrentDomain(): string {
    const domain = window.location.hostname;
    logger.debug('content', 'Current domain:', domain);
    return domain;
}

// Listen for focus events on input fields
document.addEventListener('focusin', async (e: FocusEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') {
        logger.info('content', 'Input field focused:', target);
        
        try {
            const response: Credentials = await browserAPI.runtime.sendMessage({
                type: 'GET_CREDENTIALS',
                domain: getCurrentDomain()
            });

            if (response) {
                logger.debug('content', 'Received credentials:', response);
                const fields = detectFormFields();

                if (response.username) {
                    for (const username of fields.usernames) {
                        username.value = response.username;
                        logger.info('content', 'Autofilled username field');
                    }
                }

                if (response.password) {
                    for (const password of fields.passwords) {
                        password.value = response.password;
                        logger.info('content', 'Autofilled password field');
                    }
                }
            }
        } catch (error) {
            logger.error('content', 'Error getting credentials:', error);
        }
    }
}); 
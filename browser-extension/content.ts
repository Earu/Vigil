import { Credentials, FormFields } from './types';
import { browserAPI } from './browserAPI';
import { logger } from './utils/logger';

// Inject styles
const styles = `
.vigil-dropdown {
    position: absolute;
    background: var(--bg-dark, #080808);
    border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    z-index: 999999;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    color: var(--text-primary, rgba(255, 255, 255, 0.87));
    font-size: 14px;
    max-width: 300px;
    width: 100%;
    margin-top: 4px;
}

.vigil-dropdown-item {
    padding: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    transition: background 0.2s ease;
    border-bottom: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
}

.vigil-dropdown-item:last-child {
    border-bottom: none;
}

.vigil-dropdown-item:hover {
    background: var(--overlay-light, rgba(255, 255, 255, 0.05));
}

.vigil-dropdown-item-title {
    font-weight: 500;
    color: var(--text-primary, rgba(255, 255, 255, 0.87));
}

.vigil-dropdown-item-username {
    color: var(--text-tertiary, #94a3b8);
    font-size: 12px;
}

.vigil-dropdown-empty {
    padding: 12px;
    text-align: center;
    color: var(--text-tertiary, #94a3b8);
}

.vigil-search-button {
    padding: 12px;
    text-align: center;
    background: var(--overlay-light, rgba(255, 255, 255, 0.05));
    color: var(--text-primary, rgba(255, 255, 255, 0.87));
    cursor: pointer;
    transition: background 0.2s ease;
    border-top: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
}

.vigil-search-button:hover {
    background: var(--overlay-medium, rgba(255, 255, 255, 0.1));
}

.vigil-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000000;
    backdrop-filter: blur(4px);
}

.vigil-modal {
    background: var(--bg-dark, #080808);
    border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
    border-radius: 12px;
    width: 90%;
    max-width: 500px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
}

.vigil-modal-header {
    padding: 16px;
    border-bottom: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
    display: flex;
    align-items: center;
    gap: 12px;
}

.vigil-modal-search {
    flex: 1;
    background: var(--overlay-light, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text-primary, rgba(255, 255, 255, 0.87));
    font-size: 14px;
    outline: none;
    transition: all 0.2s ease;
}

.vigil-modal-search:focus {
    background: var(--overlay-medium, rgba(255, 255, 255, 0.1));
    border-color: var(--border-secondary, rgba(255, 255, 255, 0.2));
}

.vigil-modal-close {
    background: none;
    border: none;
    color: var(--text-tertiary, #94a3b8);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s ease;
}

.vigil-modal-close:hover {
    color: var(--text-primary, rgba(255, 255, 255, 0.87));
}

.vigil-modal-content {
    padding: 16px;
    overflow-y: auto;
    max-height: calc(90vh - 120px);
}

.vigil-modal-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.vigil-modal-item {
    padding: 12px;
    background: var(--overlay-light, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
}

.vigil-modal-item:hover {
    background: var(--overlay-medium, rgba(255, 255, 255, 0.1));
    border-color: var(--border-secondary, rgba(255, 255, 255, 0.2));
    transform: translateY(-1px);
}

.vigil-modal-item-title {
    font-weight: 500;
    color: var(--text-primary, rgba(255, 255, 255, 0.87));
    margin-bottom: 4px;
}

.vigil-modal-item-username {
    font-size: 12px;
    color: var(--text-tertiary, #94a3b8);
}`;

const styleSheet = document.createElement('style');
styleSheet.textContent = styles;
document.head.appendChild(styleSheet);

interface CredentialEntry {
    id: string;
    title: string;
    username: string;
}

let currentDropdown: HTMLElement | null = null;
let currentInput: HTMLElement | null = null;
let currentModal: HTMLElement | null = null;

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

function isLoginInput(input: HTMLInputElement): "password" | "username" | null {
    if (!isElementVisible(input)) {
        return null;
    }

    if (input.type === 'password') {
        return "password";
    } else if (input.type === 'text' || input.type === 'email') {
        const fields = ['mail', 'user', 'login', 'identifier', 'username'];
        const inputFields = [input.name, input.id, input.placeholder, input.autocomplete];

        for (const inputField of inputFields) {
            if (fields.some(field => inputField.toLowerCase().includes(field))) {
                return "username";
            }
        }
    }

    return null;
}

function detectFormFields(): FormFields {
    const inputs = document.querySelectorAll('input');
    const formFields: FormFields = {
        passwords: [],
        usernames: [],
    };

    for (const input of inputs) {
        const type = isLoginInput(input);
        if (type === "password") {
            formFields.passwords.push(input);
            logger.debug('content', 'Found password field:', input);
        } else if (type === "username") {
            formFields.usernames.push(input);
            logger.debug('content', 'Found username field:', input);
        }
    }

    return formFields;
}

function getCurrentDomain(): string {
    const domain = window.location.hostname;
    logger.debug('content', 'Current domain:', domain);
    return domain;
}

function simulatePaste(element: HTMLInputElement, value: string): void {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    logger.debug('content', `Autofilled field using input event`);
}

function fillCredentials(fields: FormFields, response: Credentials): void {
    if (response.username) {
        fields.usernames.forEach(field => simulatePaste(field, response.username!));
    }

    if (response.password) {
        fields.passwords.forEach(field => simulatePaste(field, response.password!));
    }
}

function createSearchModal(target: HTMLElement): void {
    if (currentModal) {
        currentModal.remove();
    }

    const overlay = document.createElement('div');
    overlay.className = 'vigil-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'vigil-modal';

    const header = document.createElement('div');
    header.className = 'vigil-modal-header';

    const search = document.createElement('input');
    search.className = 'vigil-modal-search';
    search.type = 'text';
    search.placeholder = 'Search passwords...';
    search.autocomplete = 'off';

    const closeButton = document.createElement('button');
    closeButton.className = 'vigil-modal-close';
    closeButton.innerHTML = '✕';
    closeButton.onclick = () => {
        overlay.remove();
        currentModal = null;
    };

    header.appendChild(search);
    header.appendChild(closeButton);

    const content = document.createElement('div');
    content.className = 'vigil-modal-content';

    const list = document.createElement('div');
    list.className = 'vigil-modal-list';

    content.appendChild(list);
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    currentModal = overlay;

    // Request all entries from background script
    browserAPI.runtime.sendMessage({ type: 'GET_ALL_ENTRIES' })
        .then((entries: CredentialEntry[]) => {
            // Add index to each entry to maintain original position
            const entriesWithIndex = entries.map((entry, index) => ({ entry, originalIndex: index }));

            const renderEntries = (filteredEntries: { entry: CredentialEntry, originalIndex: number }[]) => {
                list.innerHTML = '';
                filteredEntries.forEach(({ entry, originalIndex }) => {
                    const item = document.createElement('div');
                    item.className = 'vigil-modal-item';
                    // Use the original index from the cache
                    item.dataset.entryIndex = originalIndex.toString();

                    const title = document.createElement('div');
                    title.className = 'vigil-modal-item-title';
                    title.textContent = entry.title;

                    const username = document.createElement('div');
                    username.className = 'vigil-modal-item-username';
                    username.textContent = entry.username;

                    item.appendChild(title);
                    item.appendChild(username);

                    item.addEventListener('click', async () => {
                        try {
                            const response: Credentials = await browserAPI.runtime.sendMessage({
                                type: 'GET_CREDENTIALS',
                                entryIndex: originalIndex,
                                domain: getCurrentDomain()
                            });

                            if (response.success) {
                                const fields = detectFormFields();
                                fillCredentials(fields, response);
                            }
                        } catch (error) {
                            logger.error('content', 'Error getting credentials:', error);
                        }

                        overlay.remove();
                        currentModal = null;
                        if (currentDropdown) {
                            currentDropdown.remove();
                            currentDropdown = null;
                        }
                    });

                    list.appendChild(item);
                });
            };

            renderEntries(entriesWithIndex);

            // Handle search
            search.addEventListener('input', () => {
                const query = search.value.toLowerCase();
                const filtered = entriesWithIndex.filter(({ entry }) =>
                    entry.title.toLowerCase().includes(query) ||
                    entry.username.toLowerCase().includes(query)
                );
                renderEntries(filtered);
            });
        })
        .catch(error => {
            logger.error('content', 'Error getting all entries:', error);
        });
}

function createDropdownElement(entries: CredentialEntry[], target: HTMLElement): HTMLElement {
    // Remove any existing dropdown
    if (currentDropdown) {
        currentDropdown.remove();
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'vigil-dropdown';

    if (entries.length === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'vigil-dropdown-empty';
        emptyMessage.textContent = 'No matching credentials found';
        dropdown.appendChild(emptyMessage);
    } else {
        entries.forEach((entry, index) => {
            const item = document.createElement('div');
            item.className = 'vigil-dropdown-item';
            // Use index in the filtered entries array
            item.dataset.entryIndex = index.toString();

            const content = document.createElement('div');

            const title = document.createElement('div');
            title.className = 'vigil-dropdown-item-title';
            title.textContent = entry.title;

            const username = document.createElement('div');
            username.className = 'vigil-dropdown-item-username';
            username.textContent = entry.username;

            content.appendChild(title);
            content.appendChild(username);
            item.appendChild(content);

            item.addEventListener('click', async () => {
                try {
                    // Pass the entry index relative to the filtered entries array
                    const response: Credentials = await browserAPI.runtime.sendMessage({
                        type: 'GET_CREDENTIALS',
                        entryIndex: index,
                        filteredEntries: entries,
                        domain: getCurrentDomain()
                    });

                    if (response.success) {
                        const fields = detectFormFields();
                        fillCredentials(fields, response);
                    }
                } catch (error) {
                    logger.error('content', 'Error getting credentials:', error);
                }

                dropdown.remove();
                currentDropdown = null;
            });

            dropdown.appendChild(item);
        });
    }

    // Add search button
    const searchButton = document.createElement('div');
    searchButton.className = 'vigil-search-button';
    searchButton.textContent = 'Use another password';
    searchButton.addEventListener('click', () => {
        createSearchModal(target);
    });
    dropdown.appendChild(searchButton);

    // Position the dropdown below the input
    const rect = target.getBoundingClientRect();
    dropdown.style.position = 'absolute';
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    dropdown.style.top = `${rect.bottom + window.scrollY}px`;
    dropdown.style.width = `${rect.width}px`;

    document.body.appendChild(dropdown);
    currentDropdown = dropdown;
    return dropdown;
}

// Handle clicks outside the dropdown
document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as Node;
    if (currentDropdown &&
        !currentDropdown.contains(target) &&
        currentInput !== target) {
        currentDropdown.remove();
        currentDropdown = null;
        currentInput = null;
    }
});

// Handle credential lookup for input fields
async function handleInputFocus(target: HTMLElement) {
    if (target.tagName === 'INPUT') {
        const type = isLoginInput(target as HTMLInputElement);
        if (!type) return;

        logger.debug('content', 'Input field focused:', target);
        currentInput = target;

        try {
            const response = await browserAPI.runtime.sendMessage({
                type: 'GET_AVAILABLE_ENTRIES',
                domain: getCurrentDomain()
            });

            if (response && Array.isArray(response)) {
                createDropdownElement(response, target);
            }
        } catch (error) {
            logger.error('content', 'Error getting available entries:', error);
        }
    }
}

// Listen for focus events on input fields
document.addEventListener('focusin', (e: FocusEvent) => {
    handleInputFocus(e.target as HTMLElement);
});

// Check for already focused inputs when the content script loads
function checkInitialFocus() {
    const activeElement = document.activeElement as HTMLElement;
    if (activeElement) {
        handleInputFocus(activeElement);
    }
}

// Run the initial focus check when the content script loads
checkInitialFocus();
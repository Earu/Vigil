// Type definition for browser APIs
type BrowserType = typeof chrome | typeof browser;

// Get the appropriate browser API based on the environment
const getBrowser = (): BrowserType => {
    if (typeof browser !== 'undefined') {
        return browser;  // Firefox
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) {
        return chrome;  // Chrome/Chromium
    }
    throw new Error('No browser API found');
};

// Helper function to handle Chrome's callback-based sendMessage
function chromeSendMessage<T>(message: any): Promise<T> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response: T) => {
            resolve(response);
        });
    });
}

// Create a unified API interface
export const browserAPI = {
    runtime: {
        sendMessage: <T = any>(message: any): Promise<T> => {
            const browser = getBrowser();
            if (typeof browser !== 'undefined') {
                // Firefox returns a promise
                return (browser as typeof globalThis.browser).runtime.sendMessage(message);
            }
            // Chrome uses callbacks
            return chromeSendMessage<T>(message);
        },

        onMessage: {
            addListener: (callback: any) => {
                const browser = getBrowser();
                browser.runtime.onMessage.addListener(callback);
            },
            removeListener: (callback: any) => {
                const browser = getBrowser();
                browser.runtime.onMessage.removeListener(callback);
            }
        },

        connectNative: (application: string) => {
            const browser = getBrowser();
            return browser.runtime.connectNative(application);
        },

        get lastError() {
            const browser = getBrowser();
            return browser.runtime.lastError;
        }
    },
    storage: {
        local: {
            get: (key: string) => {
                const browser = getBrowser();
                return browser.storage.local.get(key);
            },
            set: (items: { [key: string]: any }) => {
                const browser = getBrowser();
                return browser.storage.local.set(items);
            },
            remove: (key: string) => {
                const browser = getBrowser();
                return browser.storage.local.remove(key);
            }
        }
    }
} as const;

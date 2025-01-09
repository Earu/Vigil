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
        sendMessage: async <T = any>(message: any): Promise<T> => {
            const browser = getBrowser();
            let response: T;
            if (typeof browser !== 'undefined') {
                // Firefox returns a promise
                response = await (browser as typeof globalThis.browser).runtime.sendMessage(message);
            }

            // Chrome uses callbacks
            response = await chromeSendMessage<T>(message);
            return response;
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
    }
} as {
    runtime: typeof chrome.runtime | typeof browser.runtime;
};

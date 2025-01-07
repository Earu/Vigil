// Type definition for browser APIs
type BrowserType = typeof chrome | typeof browser;

// Get the appropriate browser API based on the environment
const getBrowser = (): BrowserType => {
    if (typeof chrome !== 'undefined') {
        if (typeof chrome.runtime !== 'undefined') {
            return chrome;
        }
    }
    if (typeof browser !== 'undefined') {
        return browser;
    }
    throw new Error('No browser API found');
};

// Create a unified API interface
export const browserAPI = {
    // Runtime messaging
    runtime: {
        sendMessage: async <T = any>(message: any): Promise<T> => {
            if ('browser' in window) {
                return await browser.runtime.sendMessage(message);
            }
            return new Promise((resolve) => {
                chrome.runtime.sendMessage(message, (response) => {
                    resolve(response);
                });
            });
        },
        
        onMessage: {
            addListener: (callback: (message: any, sender: any, sendResponse: any) => void) => {
                const api = getBrowser();
                api.runtime.onMessage.addListener(callback);
            },
            removeListener: (callback: (message: any, sender: any, sendResponse: any) => void) => {
                const api = getBrowser();
                api.runtime.onMessage.removeListener(callback);
            },
        },
    },

    // Storage API
    storage: {
        local: {
            get: async <T = { [key: string]: any }>(
                keys?: string | string[] | { [key: string]: any } | null
            ): Promise<T> => {
                if ('browser' in window) {
                    return await browser.storage.local.get(keys == null ? undefined : keys) as T;
                }
                return new Promise((resolve, reject) => {
                    if (keys == null) {
                        reject(new Error('Keys cannot be null'));
                        return;
                    }

                    chrome.storage.local.get(keys, (result) => {
                        resolve(result as T);
                    });
                });
            },
            set: async (items: { [key: string]: any }): Promise<void> => {
                if ('browser' in window) {
                    return await browser.storage.local.set(items);
                }
                return new Promise((resolve) => {
                    chrome.storage.local.set(items, () => {
                        resolve();
                    });
                });
            },
        },
    },

    // Tabs API
    tabs: {
        query: async (queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => {
            if ('browser' in window) {
                const tabs = await browser.tabs.query(queryInfo);
                return tabs as unknown as chrome.tabs.Tab[];
            }
            return new Promise((resolve) => {
                chrome.tabs.query(queryInfo, (tabs) => {
                    resolve(tabs);
                });
            });
        },
        
        sendMessage: async <T = any>(tabId: number, message: any): Promise<T> => {
            if ('browser' in window) {
                return await browser.tabs.sendMessage(tabId, message);
            }
            return new Promise((resolve) => {
                chrome.tabs.sendMessage(tabId, message, (response) => {
                    resolve(response);
                });
            });
        },
    },
};

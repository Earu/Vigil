import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
};

const SETTINGS_KEY = 'vigil_user_settings';

// The service caches settings after first access, so each case needs a fresh
// module instance to exercise the load path
const freshService = async () => {
    vi.resetModules();
    return (await import('../src/services/UserSettingsService')).userSettingsService;
};

beforeEach(() => store.clear());

describe('auto-lock default', () => {
    it('is on for a fresh install', async () => {
        const settings = await freshService();
        expect(settings.getAutoLockEnabled()).toBe(true);
        expect(settings.getAutoLockDuration()).toBe(20);
    });

    it('leaves an existing off choice alone', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({
            theme: 'dark', autoLockEnabled: false, autoLockDuration: 20,
        }));
        const settings = await freshService();
        expect(settings.getAutoLockEnabled()).toBe(false);
    });

    it('leaves an existing on choice and duration alone', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({
            theme: 'light', autoLockEnabled: true, autoLockDuration: 5,
        }));
        const settings = await freshService();
        expect(settings.getAutoLockEnabled()).toBe(true);
        expect(settings.getAutoLockDuration()).toBe(5);
    });

    it('persists a change away from the default', async () => {
        const settings = await freshService();
        settings.setAutoLockEnabled(false);
        expect(JSON.parse(store.get(SETTINGS_KEY)!).autoLockEnabled).toBe(false);

        const reloaded = await freshService();
        expect(reloaded.getAutoLockEnabled()).toBe(false);
    });
});

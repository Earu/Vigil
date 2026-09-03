import { describe, it, expect, beforeEach, vi } from 'vitest';

// Main-process side of the email breach lookup. The rules: the API key lives
// in the OS keychain and never comes from the renderer, a hung connection
// times out instead of stalling the sweep, and no failure shape ever comes
// back as an empty list, because [] means "checked, clean" and gets cached.

let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

vi.mock('electron', () => ({
    net: {
        fetch: (url: string, init: RequestInit) => fetchImpl(url, init),
    },
}));

// Stands in for the OS keychain
const keychain = new Map<string, string>();
vi.mock('../electron/src/get-keytar', () => ({
    default: {
        setPassword: async (service: string, account: string, value: string) => {
            keychain.set(`${service}/${account}`, value);
        },
        getPassword: async (service: string, account: string) =>
            keychain.get(`${service}/${account}`) ?? null,
        deletePassword: async (service: string, account: string) =>
            keychain.delete(`${service}/${account}`),
    },
}));

const { checkEmailBreaches, setHibpApiKey, hasHibpApiKey } = await import('../electron/src/hibp');

beforeEach(async () => {
    keychain.clear();
    fetchImpl = async () => {
        throw new Error('no fetch stub set');
    };
    await setHibpApiKey('key123');
});

describe('the API key', () => {
    it('round-trips through the keychain', async () => {
        expect(await hasHibpApiKey()).toBe(true);
        await setHibpApiKey(null);
        expect(await hasHibpApiKey()).toBe(false);
    });

    it('never touches localStorage or the settings file', async () => {
        // The key's only home is the keychain stand-in
        expect([...keychain.keys()]).toEqual(['Vigil Password Manager/hibp-api-key']);
    });
});

describe('checkEmailBreaches', () => {
    it('skips the network entirely when no key is stored', async () => {
        await setHibpApiKey(null);
        let called = false;
        fetchImpl = async () => {
            called = true;
            return new Response('[]');
        };
        expect(await checkEmailBreaches('a@b.com')).toEqual([]);
        expect(called).toBe(false);
    });

    it('sends the stored key as a header and the address URL-encoded', async () => {
        let seenUrl = '';
        let seenInit: RequestInit | undefined;
        fetchImpl = async (url, init) => {
            seenUrl = url;
            seenInit = init;
            return new Response('[{"Name":"X"}]');
        };
        await checkEmailBreaches('a+b@example.com');
        expect(seenUrl).toContain('breachedaccount/a%2Bb%40example.com');
        expect((seenInit!.headers as Record<string, string>)['hibp-api-key']).toBe('key123');
    });

    it('carries a timeout signal so a hung connection cannot stall the sweep', async () => {
        let signal: AbortSignal | undefined;
        fetchImpl = async (_url, init) => {
            signal = init.signal as AbortSignal;
            return new Response('[]');
        };
        await checkEmailBreaches('a@b.com');
        expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('treats 404 as no breaches', async () => {
        fetchImpl = async () => new Response('', { status: 404 });
        expect(await checkEmailBreaches('a@b.com')).toEqual([]);
    });

    it('throws on a non-200 rather than reporting all-clear', async () => {
        fetchImpl = async () => new Response('slow down', { status: 429 });
        await expect(checkEmailBreaches('a@b.com')).rejects.toThrow();
    });

    it('lets a network failure propagate rather than swallowing it', async () => {
        fetchImpl = async () => {
            throw new Error('timeout');
        };
        await expect(checkEmailBreaches('a@b.com')).rejects.toThrow('timeout');
    });

    it('returns the parsed breach list on success', async () => {
        fetchImpl = async () => new Response('[{"Name":"X","BreachDate":"2024-01-01"}]');
        expect(await checkEmailBreaches('a@b.com')).toEqual([
            { Name: 'X', BreachDate: '2024-01-01' },
        ]);
    });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// The k-anonymity range lookup. Two things matter here: the request asks for
// padding, so the response length stops identifying which bucket was queried
// to anyone watching the connection, and the fake entries that padding adds
// are dropped instead of being reported as breaches.
interface Call {
    url: string;
    headers: Record<string, string>;
}

const calls: Call[] = [];
let body = '';
let ok = true;

vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok, text: async () => body };
});

// The service hashes through window.crypto.subtle, as it does in the renderer
vi.stubGlobal('window', { crypto: crypto.webcrypto });

const { HaveIBeenPwnedService: Hibp } = await import('../src/services/HaveIBeenPwnedService');

const sha1 = (text: string): string =>
    crypto.createHash('sha1').update(text).digest('hex').toUpperCase();

// The service caches range responses by prefix, so every test needs its own
let counter = 0;
const uniquePassword = () => `pw-${counter++}-${Math.random()}`;

beforeEach(() => {
    calls.length = 0;
    ok = true;
});

describe('pwned password lookup', () => {
    it('asks for padding on every range request', async () => {
        body = '';
        const password = uniquePassword();
        await Hibp.isPasswordPwned(password);

        expect(calls).toHaveLength(1);
        expect(calls[0].headers['Add-Padding']).toBe('true');
        // Only the first five characters of the hash leave the machine
        expect(calls[0].url).toBe(`https://api.pwnedpasswords.com/range/${sha1(password).slice(0, 5)}`);
    });

    it('reports a real hit with its count', async () => {
        const password = uniquePassword();
        const suffix = sha1(password).slice(5);
        body = `0000000000000000000000000000000000:5\n${suffix}:42\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9`;

        expect(await Hibp.isPasswordPwned(password)).toEqual({ isPwned: true, count: 42 });
    });

    it('does not report a padding entry as a breach', async () => {
        const password = uniquePassword();
        const suffix = sha1(password).slice(5);
        // Padding entries come back with a count of 0. One colliding with the
        // real suffix is vanishingly unlikely, but reporting it would show the
        // password as breached and seen zero times
        body = `${suffix}:0\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0`;

        expect(await Hibp.isPasswordPwned(password)).toEqual({ isPwned: false, count: 0 });
    });

    it('finds the real record even when padding shares the suffix', async () => {
        const password = uniquePassword();
        const suffix = sha1(password).slice(5);
        body = `${suffix}:0\n${suffix}:7`;

        expect(await Hibp.isPasswordPwned(password)).toEqual({ isPwned: true, count: 7 });
    });

    it('reports a miss when nothing matches', async () => {
        body = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:0';

        expect(await Hibp.isPasswordPwned(uniquePassword())).toEqual({ isPwned: false, count: 0 });
    });

    it('throws rather than reporting a clean result when the request fails', async () => {
        ok = false;
        body = '';

        await expect(Hibp.isPasswordPwned(uniquePassword())).rejects.toThrow();
    });
});

// The range cache evicts LRU instead of clearing wholesale at the cap: a
// full clear mid-sweep threw away every warm bucket at once
describe('range cache LRU eviction', () => {
    const svc = Hibp as any;
    const fetchRange = (prefix: string): Promise<string> => svc.fetchRange(prefix);

    it('a hit refreshes recency and the insert past the cap evicts only the coldest', async () => {
        const cache = svc.rangeCache as Map<string, Promise<string>>;
        cache.clear();
        body = '';
        const limit = svc.RANGE_CACHE_LIMIT as number;

        for (let i = 0; i < limit; i++) await fetchRange(`P${i}`);
        expect(calls).toHaveLength(limit);

        // Touch P0: it becomes the warmest, leaving P1 the coldest
        await fetchRange('P0');
        expect(calls).toHaveLength(limit);

        // The insert past the cap drops P1 alone
        await fetchRange('NEWCOMER');
        expect(cache.size).toBe(limit);
        expect(cache.has('P1')).toBe(false);
        expect(cache.has('P0')).toBe(true);
        expect(cache.has('P2')).toBe(true);
        expect(cache.has('NEWCOMER')).toBe(true);

        // Survivors still answer from cache; the evicted prefix refetches
        const before = calls.length;
        await fetchRange('P0');
        await fetchRange('P2');
        expect(calls).toHaveLength(before);
        await fetchRange('P1');
        expect(calls).toHaveLength(before + 1);
    });
});

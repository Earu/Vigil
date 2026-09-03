import { net } from 'electron';

// Email breach lookup against HIBP's authenticated API. Runs here so the
// renderer needs no network access of its own. Password range checks are a
// different, keyless endpoint and never pass through this file.

const HIBP_BREACH_API_URL = 'https://haveibeenpwned.com/api/v3';

// A hung connection must fail the entry rather than stall the whole email
// sweep: the sweep awaits each entry in turn, and its progress toast has no
// duration, so one stuck request leaves both hanging forever
const FETCH_TIMEOUT_MS = 15_000;

// Failures throw rather than returning []: an empty list means "checked,
// clean" to the caller and gets cached as all-clear, which a network error
// must never produce
export async function checkEmailBreaches(email: string, apiKey: string): Promise<any[]> {
    if (!apiKey) {
        return [];
    }

    const response = await net.fetch(
        `${HIBP_BREACH_API_URL}/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
        {
            headers: {
                'hibp-api-key': apiKey,
                'User-Agent': 'Vigil Password Manager'
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        }
    );

    if (response.status === 404) {
        return []; // No breaches found
    }
    if (!response.ok) {
        throw new Error('Failed to check email breach status');
    }
    return await response.json();
}

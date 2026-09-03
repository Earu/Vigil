import { net } from 'electron';
import keytar from './get-keytar';

// Email breach lookup against HIBP's authenticated API. Runs here so the
// renderer needs no network access of its own. Password range checks are a
// different, keyless endpoint and never pass through this file.
//
// The API key lives in the OS keychain (same service the biometric secrets
// use), not in renderer localStorage: it is a paid, revocable credential,
// and the renderer never needs the key itself, only whether one is stored.

const HIBP_BREACH_API_URL = 'https://haveibeenpwned.com/api/v3';

const KEY_SERVICE = 'Vigil Password Manager';
const KEY_ACCOUNT = 'hibp-api-key';

export async function setHibpApiKey(key: string | null): Promise<{ success: boolean; error?: string }> {
    if (!keytar) return { success: false, error: 'Keychain is not available' };
    try {
        if (key) await keytar.setPassword(KEY_SERVICE, KEY_ACCOUNT, key);
        else await keytar.deletePassword(KEY_SERVICE, KEY_ACCOUNT);
        return { success: true };
    } catch (error) {
        console.error('Failed to store the HIBP API key:', error);
        return { success: false, error: 'Failed to store the API key' };
    }
}

export async function hasHibpApiKey(): Promise<boolean> {
    try {
        return (await keytar?.getPassword(KEY_SERVICE, KEY_ACCOUNT)) != null;
    } catch {
        return false;
    }
}

// A hung connection must fail the entry rather than stall the whole email
// sweep: the sweep awaits each entry in turn, and its progress toast has no
// duration, so one stuck request leaves both hanging forever
const FETCH_TIMEOUT_MS = 15_000;

// Failures throw rather than returning []: an empty list means "checked,
// clean" to the caller and gets cached as all-clear, which a network error
// must never produce
export async function checkEmailBreaches(email: string): Promise<any[]> {
    const apiKey = await keytar?.getPassword(KEY_SERVICE, KEY_ACCOUNT);
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

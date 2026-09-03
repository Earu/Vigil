import { net } from 'electron';

// Favicon download for the renderer's icon promotion. Runs here so the
// renderer needs no network access of its own; the URL is built from a
// validated hostname, so the renderer cannot point this at arbitrary
// endpoints. Google's s2 service answers 404 for hosts it has no icon for,
// which is what keeps placeholder globes out of the database.

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$/i;
const MAX_ICON_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export interface FaviconResult {
    success: boolean;
    data?: Uint8Array;
    error?: string;
}

export async function fetchFavicon(host: unknown): Promise<FaviconResult> {
    if (typeof host !== 'string' || host.length > 253 || !HOST_PATTERN.test(host)) {
        return { success: false, error: 'Invalid host' };
    }

    try {
        const response = await net.fetch(
            `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`,
            { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' }
        );
        if (!response.ok) {
            return { success: false, error: `No favicon (status ${response.status})` };
        }
        const type = response.headers.get('content-type') ?? '';
        if (!type.startsWith('image/')) {
            return { success: false, error: 'Response is not an image' };
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_ICON_BYTES) {
            return { success: false, error: 'Icon size out of bounds' };
        }
        return { success: true, data: new Uint8Array(buffer) };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Favicon fetch failed' };
    }
}

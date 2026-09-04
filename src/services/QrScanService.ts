import type jsQRType from 'jsqr';

export interface QrScanResult {
    text?: string;
    error?: string;
}

// Decoding runs on raw RGBA at full resolution, four bytes a pixel, so an
// image from the clipboard or a file is scaled to fit this many pixels
// first. A crafted PNG a few hundred kilobytes on disk can otherwise decode
// to gigabytes and take the renderer, and any unsaved edit, down with it.
// 16 megapixels is a 4K screenshot with room to spare; a QR code that needs
// more than that to be readable was not going to be
export const MAX_DECODE_PIXELS = 16 * 1024 * 1024;

// The size to draw an image at so it fits the pixel budget, aspect kept
export function decodeSize(width: number, height: number, maxPixels = MAX_DECODE_PIXELS): { width: number; height: number } {
    const pixels = width * height;
    if (pixels <= maxPixels) return { width, height };
    const scale = Math.sqrt(maxPixels / pixels);
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export class QrScanService {
    // jsqr only matters when scanning a TOTP QR code, so it loads on first
    // use instead of riding in the main bundle (same pattern as zxcvbn in
    // HaveIBeenPwnedService). A failed chunk load retries on the next call
    private static jsQRLoading: Promise<typeof jsQRType> | null = null;

    private static loadDecoder(): Promise<typeof jsQRType> {
        if (!this.jsQRLoading) {
            this.jsQRLoading = import('jsqr').then(module => module.default);
            this.jsQRLoading.catch(() => { this.jsQRLoading = null; });
        }
        return this.jsQRLoading;
    }

    private static async decodeImageData(data: ImageData): Promise<string | null> {
        const jsQR = await this.loadDecoder();
        const result = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
        return result?.data ?? null;
    }

    private static async imageDataFromUrl(url: string): Promise<ImageData> {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not read the image'));
            img.src = url;
        });
        const { width, height } = decodeSize(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height);
    }

    static async scanClipboard(): Promise<QrScanResult> {
        let items: ClipboardItems;
        try {
            items = await navigator.clipboard.read();
        } catch {
            return { error: 'No image in the clipboard' };
        }
        for (const item of items) {
            const type = item.types.find(t => t.startsWith('image/'));
            if (!type) continue;
            const blob = await item.getType(type);
            const url = URL.createObjectURL(blob);
            try {
                const data = await this.imageDataFromUrl(url);
                const text = await this.decodeImageData(data);
                if (text) return { text };
            } catch {
                // fall through to the generic error
            } finally {
                URL.revokeObjectURL(url);
            }
            return { error: 'No QR code found in the clipboard image' };
        }
        return { error: 'No image in the clipboard' };
    }

    // The main process captures and decodes; only the text comes back
    static async scanScreens(): Promise<QrScanResult> {
        if (!window.electron) return { error: 'Not available' };
        const result = await window.electron.qrCaptureScreens();
        if (!result.success || !result.text) return { error: result.error ?? 'Screen capture failed' };
        return { text: result.text };
    }

    static async scanFile(file: File): Promise<QrScanResult> {
        const url = URL.createObjectURL(file);
        try {
            const data = await this.imageDataFromUrl(url);
            const text = await this.decodeImageData(data);
            return text ? { text } : { error: 'No QR code found in the image' };
        } catch {
            return { error: 'Could not read the image' };
        } finally {
            URL.revokeObjectURL(url);
        }
    }
}

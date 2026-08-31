import jsQR from 'jsqr';

export interface QrScanResult {
    text?: string;
    error?: string;
}

export class QrScanService {
    private static decodeImageData(data: ImageData): string | null {
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
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    private static async decodePngBase64(pngBase64: string): Promise<string | null> {
        const data = await this.imageDataFromUrl(`data:image/png;base64,${pngBase64}`);
        return this.decodeImageData(data);
    }

    private static async decodeImages(images: string[]): Promise<string | null> {
        for (const png of images) {
            const text = await this.decodePngBase64(png).catch(() => null);
            if (text) return text;
        }
        return null;
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
                const text = this.decodeImageData(data);
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

    static async scanScreens(): Promise<QrScanResult> {
        if (!window.electron) return { error: 'Not available' };
        const result = await window.electron.qrCaptureScreens();
        if (!result.success || !result.images) return { error: result.error ?? 'Screen capture failed' };
        const text = await this.decodeImages(result.images);
        return text ? { text } : { error: 'No QR code found on screen' };
    }

    static async scanFile(file: File): Promise<QrScanResult> {
        const url = URL.createObjectURL(file);
        try {
            const data = await this.imageDataFromUrl(url);
            const text = this.decodeImageData(data);
            return text ? { text } : { error: 'No QR code found in the image' };
        } catch {
            return { error: 'Could not read the image' };
        } finally {
            URL.revokeObjectURL(url);
        }
    }
}

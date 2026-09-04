import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';

// Screen captures are decoded in the main process from the capturer's
// native image, so the renderer never sees the desktop

const { decodeQrFromImage, decodeQrFromRgba } = await import('../electron/src/qr-decode');

const URI = 'otpauth://totp/Vigil:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Vigil';

// A QR matrix as the capturer would hand it over: BGRA pixels, alpha opaque
const rasterizeBgra = (text: string, scale = 6) => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const quiet = 4;
    const dim = (size + quiet * 2) * scale;
    const bgra = Buffer.alloc(dim * dim * 4);
    for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
            const mx = Math.floor(x / scale) - quiet;
            const my = Math.floor(y / scale) - quiet;
            const dark = mx >= 0 && my >= 0 && mx < size && my < size && qr.modules.get(mx, my);
            const i = (y * dim + x) * 4;
            // A tinted code, so a channel-order mistake would show: dark
            // modules are pure blue, light ones white
            bgra[i] = 255;
            bgra[i + 1] = dark ? 0 : 255;
            bgra[i + 2] = dark ? 0 : 255;
            bgra[i + 3] = 255;
        }
    }
    return { bgra, dim };
};

const fakeImage = (bgra: Buffer, width: number, height: number) => ({
    getSize: () => ({ width, height }),
    toBitmap: () => bgra,
}) as any;

describe('decodeQrFromImage', () => {
    it('decodes a QR code out of a native BGRA bitmap', () => {
        const { bgra, dim } = rasterizeBgra(URI);
        expect(decodeQrFromImage(fakeImage(bgra, dim, dim))).toBe(URI);
    });

    it('returns null for a blank screen', () => {
        expect(decodeQrFromImage(fakeImage(Buffer.alloc(64 * 64 * 4, 255), 64, 64))).toBeNull();
    });

    it('refuses a bitmap whose size does not match its dimensions', () => {
        const { bgra, dim } = rasterizeBgra(URI);
        expect(decodeQrFromImage(fakeImage(bgra, dim + 1, dim))).toBeNull();
        expect(decodeQrFromRgba(new Uint8ClampedArray(16), 0, 0)).toBeNull();
    });
});

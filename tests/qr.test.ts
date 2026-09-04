import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { installMockWindow } from './helpers';

installMockWindow();
const { TotpService } = await import('../src/services/TotpService');

// render a QR matrix into RGBA pixels the way a canvas would hand them to jsQR
const rasterize = (text: string, scale = 8, invert = false) => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const quiet = 4;
    const dim = (size + quiet * 2) * scale;
    const rgba = new Uint8ClampedArray(dim * dim * 4);
    for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
            const mx = Math.floor(x / scale) - quiet;
            const my = Math.floor(y / scale) - quiet;
            const dark = mx >= 0 && my >= 0 && mx < size && my < size && qr.modules.get(mx, my);
            const v = (dark ? 0 : 255) ^ (invert ? 255 : 0);
            const i = (y * dim + x) * 4;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
            rgba[i + 3] = 255;
        }
    }
    return { rgba, dim };
};

const URI = 'otpauth://totp/Vigil:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Vigil&period=30&digits=6';

describe('qr decoding', () => {
    it('decodes an otpauth QR code into a usable TOTP config', () => {
        const { rgba, dim } = rasterize(URI);
        const decoded = jsQR(rgba, dim, dim, { inversionAttempts: 'attemptBoth' });
        expect(decoded?.data).toBe(URI);

        const config = TotpService.parseUserInput(decoded!.data);
        expect(config).not.toBeNull();
        expect(config!.secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        expect(config!.period).toBe(30);
        expect(config!.digits).toBe(6);
    });

    it('decodes an inverted (light-on-dark) QR code', () => {
        const { rgba, dim } = rasterize(URI, 8, true);
        const decoded = jsQR(rgba, dim, dim, { inversionAttempts: 'attemptBoth' });
        expect(decoded?.data).toBe(URI);
    });

    it('returns null for an image without a QR code', () => {
        const dim = 200;
        const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
        expect(jsQR(rgba, dim, dim, { inversionAttempts: 'attemptBoth' })).toBeNull();
    });
});

const { decodeSize, MAX_DECODE_PIXELS } = await import('../src/services/QrScanService');

describe('decode size cap', () => {

    it('leaves an ordinary image alone', () => {
        expect(decodeSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
        expect(decodeSize(4096, 4096)).toEqual({ width: 4096, height: 4096 });
    });

    it('scales a huge image down to the pixel budget, aspect kept', () => {
        const { width, height } = decodeSize(30000, 30000);
        expect(width * height).toBeLessThanOrEqual(MAX_DECODE_PIXELS);
        expect(width).toBe(height);
        const wide = decodeSize(40000, 10000);
        expect(wide.width * wide.height).toBeLessThanOrEqual(MAX_DECODE_PIXELS);
        expect(wide.width / wide.height).toBeCloseTo(4, 1);
        expect(decodeSize(1, 100_000_000).width).toBe(1);
    });
});

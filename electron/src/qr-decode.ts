import type { NativeImage } from 'electron';
import jsQR from 'jsqr';

// The screen-scan path decodes here, in the main process, so the renderer
// never receives a desktop image: it asks whether a QR code is on screen and
// gets the decoded text or nothing. A renderer bug that could call the
// capture channel therefore yields at most whatever QR code the user has up,
// which is what the feature hands over anyway

export function decodeQrFromRgba(rgba: Uint8ClampedArray, width: number, height: number): string | null {
    if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) return null;
    return jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

// Chromium's native pixel order is BGRA on every platform Electron ships;
// jsQR reads RGBA. Alpha is forced opaque: a screenshot has no transparency
// and premultiplication would otherwise be a platform detail to worry about
export function decodeQrFromImage(image: NativeImage): string | null {
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    if (bitmap.length !== width * height * 4) return null;
    const rgba = new Uint8ClampedArray(bitmap.length);
    for (let i = 0; i < bitmap.length; i += 4) {
        rgba[i] = bitmap[i + 2];
        rgba[i + 1] = bitmap[i + 1];
        rgba[i + 2] = bitmap[i];
        rgba[i + 3] = 255;
    }
    return decodeQrFromRgba(rgba, width, height);
}

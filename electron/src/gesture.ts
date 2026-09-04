import { BrowserWindow } from 'electron';

// Whether a window recently received real input. Chromium reports mouse
// buttons and keys as the OS delivered them, and page script cannot
// synthesize those events. An action that must only ever follow a click (a
// full-desktop screenshot) requires one within the window below and uses it
// up, so a renderer that calls the channel on its own gets nothing, and one
// that piggybacks on a real click gets one capture rather than a stream
const GESTURE_WINDOW_MS = 2000;
// A physical key press arrives as rawKeyDown (keyDown is what synthesized
// keyboard events carry), a touchscreen tap as touchStart and a tap gesture;
// all of those count. Movement, wheel and releases do not
const GESTURE_TYPES = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart', 'gestureTapDown', 'pointerDown']);

const lastGesture = new WeakMap<object, number>();

export function trackGestures(win: BrowserWindow, now: () => number = Date.now): void {
    win.webContents.on('input-event', (_event, input) => {
        if (GESTURE_TYPES.has(input.type)) lastGesture.set(win, now());
    });
}

export function consumeRecentGesture(win: BrowserWindow, now: number = Date.now()): boolean {
    const at = lastGesture.get(win);
    if (at === undefined || now - at > GESTURE_WINDOW_MS || now < at) return false;
    lastGesture.delete(win);
    return true;
}

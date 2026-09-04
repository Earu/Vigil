import { describe, it, expect } from 'vitest';

// A desktop screenshot may only follow real input in the asking window.
// Chromium reports that input to the main process; page script cannot fake
// it, and a gesture is spent by the first action that uses it

const { trackGestures, consumeRecentGesture } = await import('../electron/src/gesture');

type Listener = (event: unknown, input: { type: string }) => void;

const fakeWindow = () => {
    let listener: Listener | undefined;
    const win = { webContents: { on: (_name: string, fn: Listener) => { listener = fn; } } } as any;
    return { win, input: (type: string) => listener?.({}, { type }) };
};

describe('consumeRecentGesture', () => {
    it('is false for a window that saw no input', () => {
        const { win } = fakeWindow();
        trackGestures(win, () => 1000);
        expect(consumeRecentGesture(win, 1000)).toBe(false);
    });

    it('is true once after a mouse button or key, then spent', () => {
        let clock = 1000;
        const { win, input } = fakeWindow();
        trackGestures(win, () => clock);

        input('mouseDown');
        expect(consumeRecentGesture(win, 1500)).toBe(true);
        expect(consumeRecentGesture(win, 1600)).toBe(false);

        clock = 5000;
        input('rawKeyDown');
        expect(consumeRecentGesture(win, 5100)).toBe(true);

        clock = 9000;
        input('keyDown');
        expect(consumeRecentGesture(win, 9100)).toBe(true);
    });

    it('counts a touchscreen tap', () => {
        const { win, input } = fakeWindow();
        trackGestures(win, () => 1000);
        input('touchStart');
        expect(consumeRecentGesture(win, 1001)).toBe(true);
        input('gestureTapDown');
        expect(consumeRecentGesture(win, 1002)).toBe(true);
    });

    it('does not count movement, wheel or key release as a gesture', () => {
        const { win, input } = fakeWindow();
        trackGestures(win, () => 1000);
        for (const type of ['mouseMove', 'mouseWheel', 'mouseUp', 'keyUp', 'mouseEnter']) input(type);
        expect(consumeRecentGesture(win, 1001)).toBe(false);
    });

    it('expires after two seconds', () => {
        const { win, input } = fakeWindow();
        trackGestures(win, () => 1000);
        input('mouseDown');
        expect(consumeRecentGesture(win, 3001)).toBe(false);
    });

    it('keeps gestures per window', () => {
        const a = fakeWindow();
        const b = fakeWindow();
        trackGestures(a.win, () => 1000);
        trackGestures(b.win, () => 1000);
        a.input('mouseDown');
        expect(consumeRecentGesture(b.win, 1001)).toBe(false);
        expect(consumeRecentGesture(a.win, 1001)).toBe(true);
    });
});

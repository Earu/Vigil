// A copied secret must not sit in the clipboard indefinitely, and the
// countdown has to outlive whatever view started it: the generator modal is
// normally closed straight after its copy button is pressed, and the entry
// panel is closed the moment the user goes to paste.
//
// The write, the clear and the countdown that triggers it all happen in the
// main process (electron/src/clipboard): the markers that keep a copy out of
// clipboard history, the record of which value is ours, and a clear that
// still fires after this whole window is closed. The countdown here is a
// parallel one that only draws the badge; when it reaches zero it goes idle
// and leaves the actual clearing to the main-process timer.

import { userSettingsService } from './UserSettingsService';

export interface ClipboardCountdown {
    secondsLeft: number;
    // What the countdown started from, so a progress bar has a denominator;
    // the duration is a user setting read at copy time, so it can differ
    // between two countdowns
    totalSeconds: number;
    // What was copied ("Password", "Username"), for the toast wording
    label: string;
    // Which control started this countdown, so the badge appears on that
    // button alone. A label is not an identity: every entry has a field
    // called Password, and so does the generator
    source: string;
}

const IDLE: ClipboardCountdown = { secondsLeft: 0, totalSeconds: 0, label: '', source: '' };

class ClipboardServiceImpl {
    private snapshot: ClipboardCountdown = IDLE;
    private listeners = new Set<() => void>();
    private timer: ReturnType<typeof setInterval> | null = null;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    // Stable reference between changes, as useSyncExternalStore requires
    getSnapshot = (): ClipboardCountdown => this.snapshot;

    private emit(snapshot: ClipboardCountdown): void {
        this.snapshot = snapshot;
        this.listeners.forEach(listener => listener());
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async copy(text: string, label: string, source: string): Promise<boolean> {
        const totalSeconds = userSettingsService.getClipboardClearSeconds();
        try {
            if (window.electron) {
                // The duration rides along so the main process can arm the
                // clear that outlives this renderer
                const result = await window.electron.copySecret(text, totalSeconds);
                if (!result?.success) throw new Error(result?.error ?? 'Copy failed');
            } else {
                // No main process to ask (tests, a plain browser context)
                await navigator.clipboard.writeText(text);
            }
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            (window as any).showToast?.({
                message: 'Failed to copy to clipboard',
                type: 'error'
            });
            return false;
        }

        // A second copy restarts the countdown rather than inheriting what
        // was left of the previous one
        this.stopTimer();
        this.emit({ secondsLeft: totalSeconds, totalSeconds, label, source });
        this.timer = setInterval(() => {
            const secondsLeft = this.snapshot.secondsLeft - 1;
            if (secondsLeft > 0) {
                this.emit({ ...this.snapshot, secondsLeft });
                return;
            }
            // The badge goes idle; the clear is the main-process timer's.
            // Calling clearClipboard here would be worse than redundant: with
            // two windows, this window's stale countdown reaching zero must
            // not take back a secret the other window copied more recently
            this.stopTimer();
            this.emit(IDLE);
        }, 1000);

        (window as any).showToast?.({
            message: `${label} copied to clipboard`,
            type: 'success'
        });
        return true;
    }

    // The vault locked, so anything it put in the clipboard goes now rather
    // than at the end of its countdown
    clearNow(): void {
        this.stopTimer();
        this.emit(IDLE);
        void window.electron?.clearClipboard().catch(console.error);
    }
}

export const ClipboardService = new ClipboardServiceImpl();

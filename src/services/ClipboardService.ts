// A copied secret must not sit in the clipboard indefinitely, and the
// countdown has to outlive whatever view started it: the generator modal is
// normally closed straight after its copy button is pressed, and the entry
// panel is closed the moment the user goes to paste. One module level timer
// owns the pending clear, so closing a view never cuts the countdown short
// and two views can never leave two clears racing each other.
//
// The write and the clear happen in the main process (electron/src/clipboard),
// which is what lets a copy carry the macOS markers that keep it out of
// clipboard history and off the user's other devices, and what lets a quit
// mid-countdown still take the secret back. Remembering which value is ours
// lives there too, next to the clipboard it is about. What is left here is the
// countdown the UI draws.

export const CLIPBOARD_CLEAR_SECONDS = 20;

export interface ClipboardCountdown {
    secondsLeft: number;
    // What was copied ("Password", "Username"), for the toast wording
    label: string;
    // Which control started this countdown, so the badge appears on that
    // button alone. A label is not an identity: every entry has a field
    // called Password, and so does the generator
    source: string;
}

const IDLE: ClipboardCountdown = { secondsLeft: 0, label: '', source: '' };

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
        try {
            if (window.electron) {
                const result = await window.electron.copySecret(text);
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
        this.emit({ secondsLeft: CLIPBOARD_CLEAR_SECONDS, label, source });
        this.timer = setInterval(() => {
            const secondsLeft = this.snapshot.secondsLeft - 1;
            if (secondsLeft > 0) {
                this.emit({ ...this.snapshot, secondsLeft });
                return;
            }
            this.stopTimer();
            this.emit(IDLE);
            void window.electron?.clearClipboard().catch(console.error);
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

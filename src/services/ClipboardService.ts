// A copied secret must not sit in the clipboard indefinitely, and the
// countdown has to outlive whatever view started it: the generator modal is
// normally closed straight after its copy button is pressed, and the entry
// panel is closed the moment the user goes to paste. One module level timer
// owns the pending clear, so closing a view never cuts the countdown short
// and two views can never leave two clears racing each other.

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
    // What we put there, so a value the user copied from somewhere else in
    // the meantime is left alone
    private copiedText = '';

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
            await navigator.clipboard.writeText(text);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            (window as any).showToast?.({
                message: 'Failed to copy to clipboard',
                type: 'error'
            });
            return false;
        }

        this.copiedText = text;
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
            void this.clearIfUnchanged();
        }, 1000);

        (window as any).showToast?.({
            message: `${label} copied to clipboard`,
            type: 'success'
        });
        return true;
    }

    // Clear the clipboard only when it still holds what we put there; the
    // user may have copied something else since. If the read fails, clear
    // anyway rather than risk leaving a password around.
    private async clearIfUnchanged(): Promise<void> {
        if (!this.copiedText) return;
        const copied = this.copiedText;
        this.copiedText = '';
        try {
            if (await navigator.clipboard.readText() !== copied) return;
        } catch { /* fall through to clear */ }
        await window.electron?.clearClipboard().catch(console.error);
    }

    // The vault locked, so anything it put in the clipboard goes now rather
    // than at the end of its countdown
    clearNow(): void {
        this.stopTimer();
        this.emit(IDLE);
        void this.clearIfUnchanged();
    }
}

export const ClipboardService = new ClipboardServiceImpl();

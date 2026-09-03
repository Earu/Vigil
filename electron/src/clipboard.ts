import { clipboard, ClipboardItem } from 'electron';

// The vault owns the clipboard while a copied secret sits in it: it writes the
// secret, it takes it back when the countdown ends or the vault locks, and it
// takes it back on quit rather than leaving it behind for the next thing that
// pastes.
//
// The countdown that ends in the clear lives here, not in a renderer: a
// renderer dies with its window, and on macOS closing the last window quits
// nothing, so a renderer-owned countdown would leave the secret behind for
// good. The renderer keeps its own parallel countdown purely to draw the
// badge; the one armed in copySecret is the one that clears.

// Every desktop has its own way for an app to say "this is a password, do not
// record it and do not sync it", and all three are alongside the text on the
// clipboard itself rather than in any API. Electron's raw-format escape hatch
// is what puts a native clipboard type (rather than a web MIME type) there.
const rawFormat = (format: string): string =>
    `electron application/osclipboard;format="${format}"`;

// macOS (nspasteboard.org): concealed keeps the entry out of a clipboard
// manager's history, transient out of anything that persists or syncs the
// pasteboard, which is what stops a password reaching the user's other devices
// over Universal Clipboard. Only their presence carries meaning, so they carry
// a single space rather than a second copy of the secret. Not an empty string:
// see PRESENCE below
const MAC_CONCEALED = 'org.nspasteboard.ConcealedType';
const MAC_TRANSIENT = 'org.nspasteboard.TransientType';

// Windows. The first is the older convention, respected by clipboard managers
// that predate Microsoft's own and still the only one some of them check. Of
// Microsoft's three, ExcludeClipboardContentFromMonitorProcessing covers
// history (Win+V) and cross-device sync together, and the other two say the
// same thing individually for builds that only understand those. Those two are
// read as a DWORD, so it is the value rather than the presence that says no,
// and they carry a serialized zero instead of nothing
const WIN_VIEWER_IGNORE = 'Clipboard Viewer Ignore';
const WIN_EXCLUDE_MONITORS = 'ExcludeClipboardContentFromMonitorProcessing';
const WIN_CLIPBOARD_HISTORY = 'CanIncludeInClipboardHistory';
const WIN_CLOUD_CLIPBOARD = 'CanUploadToCloudClipboard';
const dwordZero = (): Blob => new Blob([new Uint8Array(4)]);

// A marker whose meaning is that it is there at all still needs something in
// it. An entry written with an empty string is dropped on the way to the
// platform clipboard and never registers a format, so a marker written that
// way protects nothing: on Windows this silently cost the two markers below
// that were written empty, while the two carrying a DWORD landed. Verified by
// enumerating the real clipboard with EnumClipboardFormats from another
// process. Anything non-empty will do, and the payload itself is never read
const PRESENCE = ' ';

// Linux. The name is KDE's because Klipper got there first, but this is the
// cross-desktop convention rather than a KDE one: CopyQ honours it, and
// wl-clipboard reads it and passes the fact on to Wayland history tools such
// as cliphist through its own CLIPBOARD_STATE=sensitive signal. There is no
// second, more universal format to write alongside it. GNOME's built-in
// clipboard keeps no history, so it needs nothing
const LINUX_PASSWORD_HINT = 'x-kde-passwordManagerHint';

// The markers are best effort by nature: they only do anything if something on
// the machine is listening for them, and an unknown one is simply ignored
function markersFor(platform: string): Record<string, string | Blob> | null {
    switch (platform) {
        case 'darwin':
            return {
                [rawFormat(MAC_CONCEALED)]: PRESENCE,
                [rawFormat(MAC_TRANSIENT)]: PRESENCE,
            };
        case 'win32':
            return {
                [rawFormat(WIN_VIEWER_IGNORE)]: PRESENCE,
                [rawFormat(WIN_EXCLUDE_MONITORS)]: PRESENCE,
                [rawFormat(WIN_CLIPBOARD_HISTORY)]: dwordZero(),
                [rawFormat(WIN_CLOUD_CLIPBOARD)]: dwordZero(),
            };
        case 'linux':
            return { [rawFormat(LINUX_PASSWORD_HINT)]: 'secret' };
        default:
            return null;
    }
}

// What the vault last wrote, so a clear only ever takes back its own value and
// leaves alone whatever the user copied from somewhere else since
let pendingSecret: string | null = null;

export function getPendingSecret(): string | null {
    return pendingSecret;
}

// The duration is a renderer-supplied setting, so it is clamped to the same
// bounds the settings UI enforces: whatever a renderer sends, a copied secret
// is cleared within ten minutes. The bounds are duplicated from
// UserSettingsService because the main process cannot import renderer code
const DEFAULT_CLEAR_SECONDS = 20;
const MIN_CLEAR_SECONDS = 5;
const MAX_CLEAR_SECONDS = 600;

let clearTimer: NodeJS.Timeout | null = null;

function cancelClearTimer(): void {
    if (clearTimer !== null) {
        clearTimeout(clearTimer);
        clearTimer = null;
    }
}

// One timer for the one clipboard: a second copy re-arms it, so the first
// copy's countdown can never take back the second copy's value early
function ownSecret(text: string, clearSeconds: unknown): void {
    pendingSecret = text;
    cancelClearTimer();
    const seconds = typeof clearSeconds === 'number' && Number.isFinite(clearSeconds)
        ? Math.min(MAX_CLEAR_SECONDS, Math.max(MIN_CLEAR_SECONDS, Math.round(clearSeconds)))
        : DEFAULT_CLEAR_SECONDS;
    clearTimer = setTimeout(() => {
        clearTimer = null;
        void clearClipboard().catch(error =>
            console.error('Failed to clear the clipboard when the countdown ran out:', error));
    }, seconds * 1000);
    // A pending clear must never be what keeps the process alive; quitting
    // has its own clear (clearOnQuit)
    clearTimer.unref?.();
}

export async function copySecret(text: string, clearSeconds?: number): Promise<{ success: boolean; error?: string }> {
    try {
        const markers = markersFor(process.platform);
        if (markers) {
            // One atomic write: the text and the markers have to land in the
            // same clipboard change, or a manager reading between the two would
            // record the secret before being told not to
            let wrote = false;
            try {
                await clipboard.write([new ClipboardItem({ 'text/plain': text, ...markers })]);
                wrote = true;
            } catch (error) {
                console.warn('Clipboard markers were refused, copying without them:', error);
            }
            // The markers are allowed to do nothing; the copy is not. Reading
            // the text back is what keeps a marker this build has never been
            // able to test on the user's desktop from costing them the paste:
            // whatever the platform makes of these formats, either the text is
            // on the clipboard or the plain write below puts it there
            if (wrote && await textLanded(text)) {
                ownSecret(text, clearSeconds);
                return { success: true };
            }
            if (wrote) {
                console.warn('Clipboard markers left the text unreadable, rewriting it plain');
            }
        }

        await clipboard.writeText(text);
        ownSecret(text, clearSeconds);
        return { success: true };
    } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        return { success: false, error: 'Failed to copy to clipboard' };
    }
}

// An unreadable clipboard is not proof the text is missing, so it counts as
// landed: rewriting on every copy would drop the markers for good on a
// platform whose clipboard simply cannot be read back
async function textLanded(text: string): Promise<boolean> {
    try {
        return (await clipboard.readText()) === text;
    } catch {
        return true;
    }
}

// Give up ownership without touching the clipboard: the value was replaced by
// something the vault did not write, so there is nothing of ours left to clear
export function forgetSecret(): void {
    pendingSecret = null;
    cancelClearTimer();
}

// Clears only when the clipboard still holds what the vault put there. With
// nothing outstanding there is nothing of ours to take back, and clearing
// anyway would throw away whatever the user copied from somewhere else. A read
// that fails does clear: leaving a password behind is the worse outcome
export async function clearClipboard(): Promise<{ success: boolean; error?: string }> {
    // Whether this is the countdown firing or an early clear (lock, quit),
    // the countdown is spent either way
    cancelClearTimer();
    const secret = pendingSecret;
    pendingSecret = null;
    if (secret === null) return { success: true };
    try {
        let current: string | null = null;
        try {
            current = await clipboard.readText();
        } catch { /* unreadable; fall through and clear */ }
        if (current !== null && current !== secret) return { success: true };
        clipboard.clear();
        return { success: true };
    } catch (error) {
        console.error('Failed to clear clipboard:', error);
        return { success: false, error: 'Failed to clear clipboard' };
    }
}

// Quitting with a countdown still running used to leave the secret in the
// clipboard for good, since the only thing that cleared it was a timer in a
// renderer that is already gone
export async function clearOnQuit(): Promise<void> {
    if (pendingSecret === null) return;
    await clearClipboard();
}

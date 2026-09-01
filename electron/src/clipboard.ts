import { clipboard, ClipboardItem } from 'electron';

// The vault owns the clipboard while a copied secret sits in it: it writes the
// secret, it takes it back when the countdown ends or the vault locks, and it
// takes it back on quit rather than leaving it behind for the next thing that
// pastes.

// Every desktop has its own way for an app to say "this is a password, do not
// record it and do not sync it", and all three are alongside the text on the
// clipboard itself rather than in any API. Electron's raw-format escape hatch
// is what puts a native clipboard type (rather than a web MIME type) there.
const rawFormat = (format: string): string =>
    `electron application/osclipboard;format="${format}"`;

// macOS (nspasteboard.org): concealed keeps the entry out of a clipboard
// manager's history, transient out of anything that persists or syncs the
// pasteboard, which is what stops a password reaching the user's other devices
// over Universal Clipboard. Only their presence carries meaning, so they are
// written empty rather than with a second copy of the secret
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
                [rawFormat(MAC_CONCEALED)]: '',
                [rawFormat(MAC_TRANSIENT)]: '',
            };
        case 'win32':
            return {
                [rawFormat(WIN_VIEWER_IGNORE)]: '',
                [rawFormat(WIN_EXCLUDE_MONITORS)]: '',
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

export async function copySecret(text: string): Promise<{ success: boolean; error?: string }> {
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
                pendingSecret = text;
                return { success: true };
            }
            if (wrote) {
                console.warn('Clipboard markers left the text unreadable, rewriting it plain');
            }
        }

        await clipboard.writeText(text);
        pendingSecret = text;
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
}

// Clears only when the clipboard still holds what the vault put there. With
// nothing outstanding there is nothing of ours to take back, and clearing
// anyway would throw away whatever the user copied from somewhere else. A read
// that fails does clear: leaving a password behind is the worse outcome
export async function clearClipboard(): Promise<{ success: boolean; error?: string }> {
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

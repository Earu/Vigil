import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

// Keeps the vault window out of screenshots and screen shares.
//
// Windows: SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE, so on
// Windows 10 2004+ the window is absent from captures entirely (older builds
// capture a black rectangle instead).
// macOS: NSWindowSharingNone. Partial protection only, because apps using
// ScreenCaptureKit can still capture the window.
// Linux: Electron does not implement this, so the setting is not offered.
//
// The preference lives in the main process rather than the renderer's
// localStorage because it has to be applied as each window is created, before
// any renderer has loaded. Same reason browser-integration.json exists.

const configFile = () => path.join(app.getPath('userData'), 'window-protection.json');

export function isSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
}

export function isContentProtectionEnabled(): boolean {
    if (!isSupported()) return false;
    try {
        const stored = JSON.parse(fs.readFileSync(configFile(), 'utf8')).enabled;
        // Anything but an explicit false keeps the protection on: a corrupt or
        // half-written config should not silently expose the vault
        return stored !== false;
    } catch {
        // No config yet (fresh install) or unreadable: on by default
        return true;
    }
}

function persist(enabled: boolean): void {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ enabled }));
}

export function applyContentProtection(win: BrowserWindow): void {
    if (!isSupported() || win.isDestroyed()) return;
    try {
        win.setContentProtection(isContentProtectionEnabled());
    } catch (error) {
        console.error('Failed to apply content protection:', error);
    }
}

export function setContentProtectionEnabled(enabled: boolean): { success: boolean; enabled: boolean; error?: string } {
    if (!isSupported()) return { success: false, enabled: false, error: 'Not supported on this platform' };
    try {
        persist(enabled);
    } catch (error) {
        console.error('Failed to save content protection setting:', error);
        return { success: false, enabled: isContentProtectionEnabled(), error: 'Failed to save the setting' };
    }
    // Every open vault window follows the change immediately
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            try {
                win.setContentProtection(enabled);
            } catch (error) {
                console.error('Failed to apply content protection:', error);
            }
        }
    }
    return { success: true, enabled };
}

import { clipboard, shell } from 'electron';
import path from 'path';

export async function clearClipboard(): Promise<{ success: boolean, error?: string }> {
    try {
        clipboard.writeText('');
        return { success: true };
    } catch (error) {
        console.error('Failed to clear clipboard:', error);
        return { success: false, error: 'Failed to clear clipboard' };
    }
}

// shell.openExternal hands whatever it is given to the OS handler for that
// scheme, and entry URLs are untrusted: they arrive from imported vaults and
// from anyone the user shares a database with. Without this, a crafted entry
// could launch file://, smb:// or any registered application protocol with one
// click on the open button
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// A URL field holding a bare host ("example.com") is normal and used to work,
// since the platform openers guess a scheme. Guess the same one here rather
// than start refusing those
function withScheme(url: string): string {
    return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

export async function openExternal(url: string): Promise<{ success: boolean; error?: string }> {
    let parsed: URL;
    try {
        parsed = new URL(withScheme(url.trim()));
    } catch {
        return { success: false, error: 'That does not look like a link' };
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return {
            success: false,
            error: `Refused to open a ${parsed.protocol.replace(':', '')} link; only web and mail links are opened`
        };
    }

    try {
        await shell.openExternal(parsed.href);
        return { success: true };
    } catch (error) {
        console.error('Failed to open external URL:', error);
        return { success: false, error: 'Failed to open the link' };
    }
}

export function getPlatform(): string {
    return process.platform;
}

export function getAppIconPath(): string {
    const platform = process.platform;
    const isDev = process.env.NODE_ENV === 'development';
    const baseDir = isDev ? process.cwd() : path.dirname(process.execPath);

    if (platform === 'win32') {
        return path.join(baseDir, 'build', 'icons', 'icon.ico');
    } else if (platform === 'darwin') {
        return path.join(baseDir, 'build', 'icons', 'icon.icns');
    } else {
        return path.join(baseDir, 'build', 'icons', 'icon_256x256.png');
    }
}
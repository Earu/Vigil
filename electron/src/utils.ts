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

export async function openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
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
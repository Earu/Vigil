import { clipboard, shell } from 'electron';

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
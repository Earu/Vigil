import log from 'electron-log/main';
import { app, shell } from 'electron';
import path from 'path';

// Field diagnostics. Packaged builds strip DevTools and their console output
// goes nowhere, so every failure (a backup that never happens, an updater
// that silently stops) was unrecoverable once the app left this machine.
// Everything below lands in userData/logs, capped and rotated by electron-log.
//
// Nothing here may ever log secrets: renderer messages arrive as plain text
// the renderer chose to send (error messages and stacks), and main-process
// logging goes through console.*, which never receives vault contents.

export function setupLogging(): void {
    log.transports.file.level = 'info';
    log.transports.file.maxSize = 5 * 1024 * 1024;
    // Owner-only rather than electron-log's 0666-minus-umask: the file holds
    // no secrets, but it does hold vault paths and error text, and on a
    // shared machine with a loose umask that is nobody else's business
    log.transports.file.writeOptions = { encoding: 'utf8', flag: 'a', mode: 0o600 };
    // In dev the terminal is the log; packaged builds have no terminal
    log.transports.console.level = app.isPackaged ? false : 'info';

    // Existing console.* diagnostics throughout electron/src become
    // retrievable without touching any of them
    Object.assign(console, log.functions);

    // uncaughtException and unhandledRejection in the main process. No
    // dialog: a background failure (a browser-integration socket error at
    // 3am) must not park a modal over the vault
    log.errorHandler.startCatching({ showDialog: false });

    // Child process crashes, renderer gone, GPU gone
    log.eventLogger.startLogging();
}

export function logRendererError(message: string): void {
    log.error(`[renderer] ${message}`);
}

export function getLogFilePath(): string {
    return log.transports.file.getFile().path;
}

// Opens the log folder in the platform file manager, same shape as
// revealBackups: this exists so a bug report can come with the file
export async function revealLogs(): Promise<{ success: boolean; error?: string }> {
    try {
        const error = await shell.openPath(path.dirname(getLogFilePath()));
        return error ? { success: false, error } : { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to open the folder' };
    }
}

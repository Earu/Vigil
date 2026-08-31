import { app, BrowserWindow, powerMonitor } from 'electron';
import { createWindow } from './src/window';
import { setupIpcHandlers } from './src/ipc';
import { setupAutoUpdater } from './src/updater';
import { handleFileOpen } from './src/file-operations';

declare global {
    namespace NodeJS {
        interface Global {
            startupFilePath: string | undefined;
        }
    }
}

function triggerLock() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('trigger-lock');
    }
}

// Transparent window support (rounded corners). The --ozone-platform-hint=auto
// flag comes from the launch command (package.json script / executableArgs):
// appendSwitch is too late for ozone platform selection.
if (process.platform === 'linux') {
    // Needed for transparent windows on X11
    app.commandLine.appendSwitch('enable-transparent-visuals');
}

app.whenReady().then(() => {
    setupIpcHandlers();
    setupAutoUpdater();
    if (process.platform === 'linux' && !process.env.WAYLAND_DISPLAY) {
        // On X11 a transparent window created right at 'ready' can come up
        // with an opaque visual; a short delay avoids it
        setTimeout(createWindow, 300);
    } else {
        createWindow();
    }

    ["suspend", "lock-screen", "unlock-screen", "resume"].forEach(evName => {
        powerMonitor.on(evName as any, triggerLock);
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Register as default handler for kdbx files
app.setAsDefaultProtocolClient('kdbx');

// Handle file opening on Windows/Linux
if (process.platform !== 'darwin') {
    const filePath = process.argv.find(arg => arg.endsWith('.kdbx'));
    if (filePath) {
        global.startupFilePath = filePath;
    }
}

// Handle file opening on macOS
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
        handleFileOpen(filePath);
    } else {
        global.startupFilePath = filePath;
    }
});

// Handle file opening from command line arguments on Windows
if (process.platform === 'win32') {
    const filePath = process.argv.find(arg => arg.endsWith('.kdbx'));
    if (filePath) {
        global.startupFilePath = filePath;
    }
}
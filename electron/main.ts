import { app, BrowserWindow, powerMonitor } from 'electron';
import { createWindow } from './src/window';
import { setupIpcHandlers } from './src/ipc';
import { handleFileOpen } from './src/file-operations';
import { setupHttpServer } from './src/api';

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

function triggerLock() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('trigger-lock');
    }
}

app.whenReady().then(() => {
    setupIpcHandlers();
    createWindow();
    setupHttpServer();

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
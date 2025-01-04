import { app, BrowserWindow, powerMonitor } from 'electron';
import { createWindow } from './src/window';
import { setupIpcHandlers } from './src/ipc';
import { handleFileOpen } from './src/file-operations';

declare global {
    namespace NodeJS {
        interface Global {
            startupFilePath: string | undefined;
        }
    }
}

let mainWindow: BrowserWindow | null = null;
app.whenReady().then(() => {
    setupIpcHandlers();
    mainWindow = createWindow();

    powerMonitor.on('suspend', () => {
        if (!mainWindow?.isDestroyed()) {
            mainWindow?.webContents.send('trigger-lock');
        }
    });

    powerMonitor.on('lock-screen', () => {
        if (!mainWindow?.isDestroyed()) {
            mainWindow?.webContents.send('trigger-lock');
        }
    });

    powerMonitor.on('unlock-screen', () => {
        if (!mainWindow?.isDestroyed()) {
            mainWindow?.webContents.send('trigger-lock');
        }
    });

    powerMonitor.on('resume', () => {
        if (!mainWindow?.isDestroyed()) {
            mainWindow?.webContents.send('trigger-lock');
        }
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
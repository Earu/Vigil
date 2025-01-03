import { BrowserWindow, ipcMain, app } from 'electron';
import path from 'path';

let pendingFileOpen: { data: Buffer, path: string } | null = null;

export function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: false,
        backgroundColor: '#1a1a1a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Set security-related headers including CSP
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    process.env.NODE_ENV === 'development'
                        ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
                          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
                          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                          "img-src 'self' data: https://www.google.com https://*.gstatic.com; " +
                          "font-src 'self' https://fonts.gstatic.com; " +
                          "connect-src 'self' ws://localhost:5173 http://localhost:5173 https://api.pwnedpasswords.com https://haveibeenpwned.com; " +
                          "base-uri 'self'; " +
                          "form-action 'none'; " +
                          "frame-ancestors 'none';"
                        : "default-src 'self';" +
                          "script-src 'self';" +
                          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
                          "img-src 'self' data: https://www.google.com https://*.gstatic.com;" +
                          "font-src 'self' https://fonts.gstatic.com;" +
                          "connect-src 'self' https://api.pwnedpasswords.com https://haveibeenpwned.com;" +
                          "base-uri 'self';" +
                          "form-action 'none';" +
                          "frame-ancestors 'none';"
                ]
            }
        });
    });

    // Prevent navigation and new window creation
    win.webContents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        if (process.env.NODE_ENV === 'development') {
            if (parsedUrl.origin !== 'http://localhost:5173') {
                event.preventDefault();
            }
        } else {
            event.preventDefault();
        }
    });

    win.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
    });

    // Add this handler for when the window is ready
    win.webContents.on('did-finish-load', () => {
        if (pendingFileOpen) {
            win.webContents.send('file-opened', pendingFileOpen);
            pendingFileOpen = null;
        }
    });

    // Register window-specific IPC handlers
    type WindowHandler = [string, (...args: any[]) => any];
    const windowHandlers: WindowHandler[] = [
        ['minimize-window', () => win.minimize()],
        ['maximize-window', () => {
            if (win.isMaximized()) {
                win.unmaximize();
            } else {
                win.maximize();
            }
        }],
        ['close-window', () => win.close()]
    ];

    // Register each handler and store their removal functions
    const removeHandlers = windowHandlers.map(([channel, handler]) => {
        ipcMain.handle(channel, handler);
        return () => {
            try {
                ipcMain.removeHandler(channel);
            } catch (error) {
                console.warn(`Handler ${channel} already removed`);
            }
        };
    });

    win.on('closed', () => {
        removeHandlers.forEach(remove => remove());
    });

    win.on('maximize', () => {
        win.webContents.send('window-maximized', true);
    });

    win.on('unmaximize', () => {
        win.webContents.send('window-maximized', false);
    });

    if (process.env.NODE_ENV === 'development') {
        win.loadURL('http://localhost:5173');
        win.webContents.openDevTools();
    } else {
        const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');
        console.log('Loading production file from:', indexPath);
        win.loadFile(indexPath);
    }

    return win;
}

export function setPendingFileOpen(data: { data: Buffer, path: string }) {
    pendingFileOpen = data;
}
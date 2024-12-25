import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		frame: false,
		backgroundColor: '#1a1a1a',
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: true,
			preload: path.join(__dirname, 'preload.js')
		}
	});

	ipcMain.handle('minimize-window', () => {
		win.minimize();
	})

	ipcMain.handle('maximize-window', () => {
		if (win.isMaximized()) {
			win.unmaximize();
		} else {
			win.maximize();
		}
	})

	ipcMain.handle('close-window', () => {
		win.close();
	})

	win.on('maximize', () => {
		win.webContents.send('window-maximized', true)
	})

	win.on('unmaximize', () => {
		win.webContents.send('window-maximized', false)
	})

	if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
		win.loadURL('http://localhost:5173');
		win.webContents.openDevTools();
	} else {
		const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
		console.log('Loading production file from:', indexPath);
		win.loadFile(indexPath);
	}
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
})

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
})

ipcMain.handle('save-file', async (_, data: Uint8Array) => {
	const { filePath, canceled } = await dialog.showSaveDialog({
		filters: [
			{ name: 'KeePass Database', extensions: ['kdbx'] }
		],
		defaultPath: 'database.kdbx'
	});

	if (canceled || !filePath) {
		return { success: false, error: 'Save cancelled' };
	}

	try {
		await fs.promises.writeFile(filePath, Buffer.from(data));
		return { success: true, filePath };
	} catch (error) {
		console.error('Failed to save file:', error);
		return { success: false, error: 'Failed to save file' };
	}
});
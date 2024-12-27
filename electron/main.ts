import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'

// Add path for storing last database location
const LAST_DB_PATH = path.join(app.getPath('userData'), 'last_database.json');

// Function to save last database path
async function saveLastDatabasePath(dbPath: string) {
	try {
		await fs.promises.writeFile(LAST_DB_PATH, JSON.stringify({ path: dbPath }));
		return true;
	} catch (error) {
		console.error('Failed to save last database path:', error);
		return false;
	}
}

// Function to load last database path
async function loadLastDatabasePath(): Promise<string | null> {
	try {
		if (fs.existsSync(LAST_DB_PATH)) {
			const data = await fs.promises.readFile(LAST_DB_PATH, 'utf-8');
			const { path: dbPath } = JSON.parse(data);
			// Verify the file still exists
			if (fs.existsSync(dbPath)) {
				return dbPath;
			}
		}
		return null;
	} catch (error) {
		console.error('Failed to load last database path:', error);
		return null;
	}
}

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

	if (process.env.NODE_ENV === 'development') {
		win.loadURL('http://localhost:5173');
		win.webContents.openDevTools();
	} else {
		const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
		console.log('Loading production file from:', indexPath);
		win.loadFile(indexPath);

		// Ensure required resources can load
		win.webContents.session.webRequest.onBeforeRequest({ urls: ['file://*/*'] },
			(_, callback) => {
				callback({ cancel: false });
			}
		);
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
		await saveLastDatabasePath(filePath); // Save the last used path
		return { success: true, filePath };
	} catch (error) {
		console.error('Failed to save file:', error);
		return { success: false, error: 'Failed to save file' };
	}
});

ipcMain.handle('save-to-file', async (_, filePath: string, data: Uint8Array) => {
	try {
		await fs.promises.writeFile(filePath, Buffer.from(data));
		return { success: true };
	} catch (error) {
		console.error('Failed to save file:', error);
		return { success: false, error: 'Failed to save file' };
	}
});

ipcMain.handle('get-file-path', async (_, filePath: string) => {
	try {
		// If it's already an absolute path, return it
		if (path.isAbsolute(filePath)) {
			return filePath;
		}

		// Try to resolve relative to the app's current working directory
		const resolvedPath = path.resolve(process.cwd(), filePath);
		if (fs.existsSync(resolvedPath)) {
			return resolvedPath;
		}

		// If we can't find the file, return null
		return null;
	} catch (error) {
		console.error('Error resolving file path:', error);
		return null;
	}
});

ipcMain.handle('open-file', async () => {
	const result = await dialog.showOpenDialog({
		properties: ['openFile'],
		filters: [
			{ name: 'KeePass Database', extensions: ['kdbx'] }
		]
	});

	return {
		filePath: result.filePaths[0],
		canceled: result.canceled
	};
});

ipcMain.handle('read-file', async (_, filePath: string) => {
	try {
		const data = await fs.promises.readFile(filePath);
		return { success: true, data };
	} catch (error) {
		console.error('Failed to read file:', error);
		return { success: false, error: 'Failed to read file' };
	}
});

// Add new IPC handlers for last database path
ipcMain.handle('get-last-database-path', async () => {
	return await loadLastDatabasePath();
});

ipcMain.handle('save-last-database-path', async (_, dbPath: string) => {
	return await saveLastDatabasePath(dbPath);
});
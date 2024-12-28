import { app, BrowserWindow, ipcMain, dialog, systemPreferences } from 'electron'
import path from 'path'
import fs from 'fs'

// Import keytar and Windows Hello dynamically based on environment
let keytar: typeof import('keytar');
let windowsHello: {
	isAvailable: () => boolean;
	register: (message: string) => Promise<boolean>;
	authenticate: (message: string) => Promise<boolean>;
} | null = null;

try {
	if (process.env.NODE_ENV === 'development') {
		keytar = require('keytar');
		if (process.platform === 'win32') {
			windowsHello = require('../native/windows_hello/binding');
		}
	} else {
		const keytarPath = path.join(__dirname, 'native_modules', 'keytar.node');
		keytar = require(keytarPath);
		if (process.platform === 'win32') {
			const windowsHelloPath = path.join(__dirname, 'native_modules', 'windows_hello', 'binding.js');
			windowsHello = require(windowsHelloPath);
		}
	}
} catch (error) {
	console.error('Failed to load native modules:', error);
}

// Add path for storing last database location
const LAST_DB_PATH = path.join(app.getPath('userData'), 'last_database.json');
const SERVICE_NAME = 'Vigil Password Manager';

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

// Function to check if biometrics is available
let biometricsAvailableCache: boolean | null = null;

async function isBiometricsAvailable(): Promise<boolean> {
	if (biometricsAvailableCache !== null) {
		return biometricsAvailableCache;
	}

	try {
		if (process.platform === 'darwin') {
			// On macOS, use systemPreferences to check for Touch ID availability
			const canPromptTouchID = systemPreferences.canPromptTouchID();
			biometricsAvailableCache = canPromptTouchID;
		} else if (process.platform === 'win32' /*&& windowsHello*/) {
			// On Windows, use our native module to check Windows Hello availability
			biometricsAvailableCache = false; //windowsHello.isAvailable();
		} else {
			// For other platforms, return false as biometrics are not supported
			biometricsAvailableCache = false;
		}
	} catch (error) {
		console.error('Error checking biometrics availability:', error);
		biometricsAvailableCache = false;
	}

	return biometricsAvailableCache || false;
}

// Function to prompt for biometric authentication
async function authenticateWithBiometrics(data: { dbName: string }): Promise<boolean> {
	if (process.platform === 'darwin') {
		try {
			await systemPreferences.promptTouchID(`unlock ${data.dbName} with biometrics`);
			return true;
		} catch (error) {
			console.error('TouchID authentication failed:', error);
			return false;
		}
	} else if (process.platform === 'win32' && windowsHello) {
		try {
			return await windowsHello.authenticate(`Unlock ${data.dbName} with Windows Hello`);
		} catch (error) {
			console.error('Windows Hello authentication failed:', error);
			return false;
		}
	}
	return false;
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

// Add new IPC handler to check if biometrics is enabled for a database
ipcMain.handle('has-biometrics-enabled', async (_, dbPath: string) => {
	try {
		const hasPassword = await keytar.getPassword(SERVICE_NAME, dbPath);
		return { success: true, enabled: !!hasPassword };
	} catch (error) {
		console.error('Failed to check biometrics status:', error);
		return { success: false, error: 'Failed to check biometrics status' };
	}
});

// Add new IPC handlers for biometric authentication
ipcMain.handle('is-biometrics-available', async () => {
	return await isBiometricsAvailable();
});

ipcMain.handle('enable-biometrics', async (_, dbPath: string, password: string) => {
	try {
		if (!await isBiometricsAvailable()) {
			return { success: false, error: 'Biometric authentication is not available on this device' };
		}

		// First register the Windows Hello credential
		if (process.platform === 'win32' && windowsHello) {
			const registerResult = await windowsHello.register(`Register Windows Hello for ${dbPath.split('/').pop()}`);
			if (!registerResult) {
				return { success: false, error: 'Failed to register Windows Hello' };
			}
		}

		// Then authenticate to verify it works
		if (!await authenticateWithBiometrics({ dbName: dbPath.split('/').pop() as string })) {
			return { success: false, error: 'Biometric authentication failed' };
		}

		await keytar.setPassword(SERVICE_NAME, dbPath, password);
		return { success: true };
	} catch (error) {
		console.error('Failed to enable biometrics:', error);
		return { success: false, error: 'Failed to enable biometric authentication' };
	}
});

ipcMain.handle('get-biometric-password', async (_, dbPath: string) => {
	try {
		if (!await isBiometricsAvailable()) {
			return { success: false, error: 'Biometric authentication is not available on this device' };
		}

		if (!await authenticateWithBiometrics({ dbName: dbPath.split('/').pop() as string })) {
			return { success: false, error: 'Biometric authentication failed' };
		}

		const password = await keytar.getPassword(SERVICE_NAME, dbPath);
		if (!password) {
			return { success: false, error: 'No password found for this database' };
		}

		return { success: true, password };
	} catch (error) {
		console.error('Failed to get password with biometrics:', error);
		return { success: false, error: 'Failed to authenticate with biometrics' };
	}
});

ipcMain.handle('disable-biometrics', async (_, dbPath: string) => {
	try {
		await keytar.deletePassword(SERVICE_NAME, dbPath);
		return { success: true };
	} catch (error) {
		console.error('Failed to disable biometrics:', error);
		return { success: false, error: 'Failed to disable biometric authentication' };
	}
});
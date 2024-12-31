import { app, BrowserWindow, ipcMain, dialog, systemPreferences, clipboard, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import * as argon2 from '@node-rs/argon2';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import { execSync } from 'child_process';

let Passport: any;
if (process.platform === 'win32') {
    const { Passport: WindowsPassport } = require('passport-desktop');
    Passport = WindowsPassport;
}

// Import keytar dynamically based on environment
let keytar: typeof import('keytar');

try {
	if (process.env.NODE_ENV === 'development') {
		keytar = require('keytar');
	} else {
		const keytarPath = path.join(__dirname, 'native_modules', 'keytar.node');
		keytar = require(keytarPath);
	}
} catch (error) {
	console.error('Failed to load native modules:', error);
}

const LAST_DB_PATH = path.join(app.getPath('userData'), 'last_database.json');
const SERVICE_NAME = 'Vigil Password Manager';
const SALT_PATH = path.join(app.getPath('userData'), '.salt');

function generateNewSalt(): string {
	const buffer = Buffer.alloc(32);
	require('crypto').randomFillSync(buffer);
	return buffer.toString('hex');
}

async function getInstallationSalt(): Promise<string> {
	try {
		if (fs.existsSync(SALT_PATH)) {
			return await fs.promises.readFile(SALT_PATH, 'utf-8');
		}

		// Generate and save new salt if it doesn't exist
		const newSalt = generateNewSalt();
		await fs.promises.writeFile(SALT_PATH, newSalt, { mode: 0o600 }); // Restrictive permissions
		return newSalt;
	} catch (error) {
		console.error('Failed to manage installation salt:', error);
		// Fallback to a temporary salt if file operations fail
		// This ensures the app still works but will prompt for biometric re-authentication
		return generateNewSalt();
	}
}

async function generateUniqueKey(dbPath: string): Promise<string> {
	const salt = await getInstallationSalt();
	return `${dbPath}_${salt}`;
}

async function saveLastDatabasePath(dbPath: string) {
	try {
		await fs.promises.writeFile(LAST_DB_PATH, JSON.stringify({ path: dbPath }));
		return true;
	} catch (error) {
		console.error('Failed to save last database path:', error);
		return false;
	}
}

async function loadLastDatabasePath(): Promise<string | null> {
	try {
		if (fs.existsSync(LAST_DB_PATH)) {
			const data = await fs.promises.readFile(LAST_DB_PATH, 'utf-8');
			const { path: dbPath } = JSON.parse(data);
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
		} else if (process.platform === 'win32') {
			// On Windows, use passport-desktop to check Windows Hello availability
			biometricsAvailableCache = Passport.available();
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

async function authenticateWithBiometrics(data: { dbPath: string, dbName: string }): Promise<boolean> {
	if (process.platform === 'darwin') {
		try {
			await systemPreferences.promptTouchID(`unlock ${data.dbName} with biometrics`);
			return true;
		} catch (error) {
			console.error('TouchID authentication failed:', error);
			return false;
		}
	} else if (process.platform === 'win32') {
		try {
			const passport = new Passport(data.dbPath);
			if (!passport.accountExists) {
				await passport.createAccount(); // This will show the Windows Hello prompt
				return true;
			}

			const result = await Passport.requestVerification(`Unlock ${data.dbName} with Windows Hello`);
			return result === 0; // 0 is VerificationResult.Verified
		} catch (error) {
			console.error('Windows Hello authentication failed:', error);
			return false;
		}
	}
	return false;
}

let pendingFileOpen: { data: Buffer, path: string } | null = null;
function createWindow() {
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
				],
				'X-Content-Type-Options': ['nosniff'],
				'X-Frame-Options': ['DENY'],
				'X-XSS-Protection': ['1; mode=block']
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
			console.log('[Main] Sending pending file-opened event');
			win.webContents.send('file-opened', pendingFileOpen);
			pendingFileOpen = null;
		}
	});

	if (global.startupFilePath) {
		handleFileOpen(global.startupFilePath);
		global.startupFilePath = undefined;
	}

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
				// Handler might already be removed
				console.log(`Handler ${channel} already removed`);
			}
		};
	});

	win.on('closed', () => {
		// Clean up handlers when window is closed
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
		const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
		console.log('Loading production file from:', indexPath);
		win.loadFile(indexPath);
	}
}

app.whenReady().then(createWindow);

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

ipcMain.handle('argon2', async (_, password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
	const hash = await argon2.hashRaw(new Uint8Array(password), {
		memoryCost: memory,
		timeCost: iterations,
		outputLen: length,
		parallelism: parallelism,
		algorithm: type,
		version: version == 16 ? argon2.Version.V0x10 : argon2.Version.V0x13,
		salt: new Uint8Array(salt),
	});

	return hash;
});

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
	const { filePaths, canceled } = await dialog.showOpenDialog({
		properties: ['openFile'],
		filters: [{ name: 'KeePass Database', extensions: ['kdbx'] }]
	});

	if (canceled || filePaths.length === 0) {
		return { success: false, error: 'Open cancelled' };
	}

	try {
		const filePath = filePaths[0];
		await handleFileOpen(filePath);
		return { success: true, filePath };
	} catch (error) {
		console.error('Failed to open file:', error);
		return { success: false, error: 'Failed to open file' };
	}
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
		if (!await isBiometricsAvailable()) {
			return { success: false, error: 'Biometric authentication is not available on this device' };
		}

		const key = await generateUniqueKey(dbPath);
		const hasPassword = await keytar.getPassword(SERVICE_NAME, key);
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

// Function to get hardware-specific information
async function getHardwareId(): Promise<string> {
	if (process.platform === 'win32') {
		// On Windows, use Windows Management Instrumentation (WMI)

		try {
			// Get motherboard serial number
			const mbSerial = execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim();
			// Get CPU ID
			const cpuId = execSync('wmic cpu get processorid').toString().split('\n')[1].trim();
			return `${mbSerial}-${cpuId}`;
		} catch (error) {
			console.error('Failed to get hardware ID:', error);
			// Fallback to a combination of username and machine name
			return `${process.env.USERNAME}-${process.env.COMPUTERNAME}`;
		}
	} else if (process.platform === 'darwin') {
		// On macOS, use system_profiler
		try {
			// Get hardware UUID
			const hardwareUUID = execSync('system_profiler SPHardwareDataType | grep "Hardware UUID"').toString().split(':')[1].trim();
			return hardwareUUID;
		} catch (error) {
			console.error('Failed to get hardware ID:', error);
			// Fallback to username and hostname
			return `${process.env.USER}-${execSync('hostname').toString().trim()}`;
		}
	} else {
		// On Linux, try to use DMI information
		try {
			// Try to get motherboard serial
			const mbSerial = execSync('sudo dmidecode -s baseboard-serial-number').toString().trim();
			return mbSerial;
		} catch (error) {
			console.error('Failed to get hardware ID:', error);
			// Fallback to machine-id which is usually available on Linux
			try {
				return fs.readFileSync('/etc/machine-id', 'utf8').trim();
			} catch {
				// Last resort fallback
				return `${process.env.USER}-${execSync('hostname').toString().trim()}`;
			}
		}
	}
}

// Function to derive an encryption key from hardware ID and salt
async function deriveEncryptionKey(hardwareId: string, salt: string): Promise<Buffer> {
	return pbkdf2Sync(hardwareId, salt, 100000, 32, 'sha512');
}

// Function to encrypt password before storing
async function encryptPassword(password: string): Promise<string> {
	const hardwareId = await getHardwareId();
	const salt = await getInstallationSalt();
	const key = await deriveEncryptionKey(hardwareId, salt);
	const iv = randomBytes(16);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	// Return IV + Auth Tag + Encrypted data as base64
	return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// Function to decrypt stored password
async function decryptPassword(encryptedData: string): Promise<string> {
	const hardwareId = await getHardwareId();
	const salt = await getInstallationSalt();
	const key = await deriveEncryptionKey(hardwareId, salt);
	const data = Buffer.from(encryptedData, 'base64');
	const iv = data.subarray(0, 16);
	const authTag = data.subarray(16, 32);
	const encrypted = data.subarray(32);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(authTag);
	return decipher.update(encrypted) + decipher.final('utf8');
}

ipcMain.handle('enable-biometrics', async (_, dbPath: string, password: string) => {
	try {
		if (!await isBiometricsAvailable()) {
			return { success: false, error: 'Biometric authentication is not available on this device' };
		}

		if (!await authenticateWithBiometrics({ dbPath, dbName: dbPath.split('/').pop() as string })) {
			return { success: false, error: 'Biometric authentication failed' };
		}

		const key = await generateUniqueKey(dbPath);
		const encryptedPassword = await encryptPassword(password);
		await keytar.setPassword(SERVICE_NAME, key, encryptedPassword);
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

		if (!await authenticateWithBiometrics({ dbPath, dbName: dbPath.split('/').pop() as string })) {
			return { success: false, error: 'Biometric authentication failed' };
		}

		const key = await generateUniqueKey(dbPath);
		const encryptedPassword = await keytar.getPassword(SERVICE_NAME, key);
		if (!encryptedPassword) {
			return { success: false, error: 'No password found for this database' };
		}

		const password = await decryptPassword(encryptedPassword);
		return { success: true, password };
	} catch (error) {
		console.error('Failed to get password with biometrics:', error);
		return { success: false, error: 'Failed to authenticate with biometrics' };
	}
});

ipcMain.handle('disable-biometrics', async (_, dbPath: string) => {
	try {
		const key = await generateUniqueKey(dbPath);
		await keytar.deletePassword(SERVICE_NAME, key);
		return { success: true };
	} catch (error) {
		console.error('Failed to disable biometrics:', error);
		return { success: false, error: 'Failed to disable biometric authentication' };
	}
});

ipcMain.handle('clear-clipboard', () => {
	try {
		clipboard.writeText('');
		return { success: true };
	} catch (error) {
		console.error('Failed to clear clipboard:', error);
		return { success: false, error: 'Failed to clear clipboard' };
	}
});

ipcMain.handle('open-external', async (_, url: string) => {
	await shell.openExternal(url);
});

// Add platform detection handler
ipcMain.handle('get-platform', () => "win32");

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

// Function to handle opening files
async function handleFileOpen(filePath: string) {
	try {
		const result = await fs.promises.readFile(filePath);
		const mainWindow = BrowserWindow.getAllWindows()[0];
		const fileData = {
			data: result,
			path: filePath
		};

		if (mainWindow?.webContents.isLoading()) {
			pendingFileOpen = fileData;
		} else if (mainWindow) {
			mainWindow.webContents.send('file-opened', fileData);
		}
	} catch (error) {
		console.error('Failed to open file:', error);
	}
}

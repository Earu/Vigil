export type UpdateStatus =
	| { state: 'disabled' }
	| { state: 'idle' }
	| { state: 'checking' }
	| { state: 'up-to-date' }
	| { state: 'downloading'; version: string }
	| { state: 'downloaded'; version: string }
	| { state: 'error'; message: string };

export interface IElectronAPI {
	minimizeWindow: () => Promise<void>;
	maximizeWindow: () => Promise<void>;
	closeWindow: () => Promise<void>;
	onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
	saveFile: (data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	saveToFile: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
	saveAttachment: (name: string, data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	getFilePath: (path: string) => Promise<string | null>;
	openFile: () => Promise<{ filePath: string; canceled: boolean }>;
	readFile: (filePath: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
	selectKeyFile: () => Promise<{ canceled: boolean; filePath?: string }>;
	statFile: (filePath: string) => Promise<{ success: boolean; mtimeMs?: number; size?: number; error?: string }>;
	getLastDatabasePath: () => Promise<string | null>;
	saveLastDatabasePath: (path: string) => Promise<boolean>;
	isBiometricsAvailable: () => Promise<boolean>;
	enableBiometrics: (dbPath: string, password: string) => Promise<{ success: boolean; error?: string }>;
	getBiometricPassword: (dbPath: string) => Promise<{ success: boolean; password?: string; error?: string }>;
	hasBiometricsEnabled: (dbPath: string) => Promise<{ success: boolean; enabled: boolean; error?: string }>;
	disableBiometrics: (dbPath: string) => Promise<{ success: boolean; error?: string }>;
	clearClipboard: () => Promise<{ success: boolean; error?: string }>;
	argon2: (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => Promise<ArrayBuffer>;
	openExternal: (url: string) => Promise<void>;
	getPlatform: () => Promise<string>;
	on: (channel: string, callback: (...args: any[]) => void) => () => void;
	checkEmailBreaches: (email: string, apiKey: string) => Promise<any[]>;
	showNotification: (options: { title: string, body: string }) => Promise<void>;
	reportVaultOpened: (filePath: string) => Promise<{ duplicate: boolean }>;
	reportVaultClosed: () => Promise<void>;
	qrCaptureScreens: () => Promise<{ success: boolean; images?: string[]; error?: string }>;
	browserIntegrationRespond: (id: number, result: unknown) => void;
	getBrowserIntegrationStatus: () => Promise<{ supported: boolean; enabled: boolean; running: boolean; socketPath: string }>;
	setBrowserIntegrationEnabled: (enabled: boolean) => Promise<{ success: boolean; running: boolean; written?: string[]; error?: string }>;
	installBrowserManifests: () => Promise<{ success: boolean; written: string[]; error?: string }>;
	getUpdateStatus: () => Promise<UpdateStatus>;
	checkForUpdates: () => Promise<UpdateStatus>;
	installUpdate: () => Promise<void>;
}

declare global {
	interface Window {
		electron?: IElectronAPI;
	}
	var startupFilePath: string | undefined;
}

export {};
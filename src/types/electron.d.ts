export interface IElectronAPI {
	minimizeWindow: () => Promise<void>;
	maximizeWindow: () => Promise<void>;
	closeWindow: () => Promise<void>;
	onMaximizeChange: (callback: (maximized: boolean) => void) => void;
	saveFile: (data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	saveToFile: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
	getFilePath: (path: string) => Promise<string | null>;
	openFile: () => Promise<{ filePath: string; canceled: boolean }>;
	readFile: (filePath: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
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
	on: (channel: string, callback: (...args: any[]) => void) => void;
	off: (channel: string, callback: (...args: any[]) => void) => void;
}

declare global {
	interface Window {
		electron?: IElectronAPI;
	}
	var startupFilePath: string | undefined;
}

export {};
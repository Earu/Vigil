export interface IElectronAPI {
	minimizeWindow: () => Promise<void>;
	maximizeWindow: () => Promise<void>;
	closeWindow: () => Promise<void>;
	onMaximizeChange: (callback: (maximized: boolean) => void) => void;
	saveFile: (data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	saveToFile: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
	getFilePath: (path: string) => Promise<string>;
	openFile: () => Promise<{ filePath: string; canceled: boolean }>;
	readFile: (filePath: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
	getLastDatabasePath: () => Promise<string | null>;
	saveLastDatabasePath: (path: string) => Promise<boolean>;
}

declare global {
	interface Window {
		electron?: IElectronAPI;
	}
}
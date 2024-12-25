export interface IElectronAPI {
	minimizeWindow: () => Promise<void>;
	maximizeWindow: () => Promise<void>;
	closeWindow: () => Promise<void>;
	onMaximizeChange: (callback: (maximized: boolean) => void) => void;
	saveFile: (data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	saveToFile: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
	getFilePath: (path: string) => Promise<string>;
}

declare global {
	interface Window {
		electron?: IElectronAPI;
	}
}
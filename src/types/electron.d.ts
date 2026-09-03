export type UpdateStatus =
	| { state: 'disabled' }
	| { state: 'idle' }
	| { state: 'checking' }
	| { state: 'up-to-date' }
	| { state: 'downloading'; version: string }
	| { state: 'downloaded'; version: string }
	| { state: 'error'; message: string };

export interface HardwareKeyInfo {
	path: string;
	product: string;
	serial: number | null;
	slot1Configured: boolean;
	slot2Configured: boolean;
}

export interface BackupOptions {
	enabled: boolean;
	keep: number;
	/** Set when this save replaces a version of the file Vigil did not write,
	 *  so the copy is taken regardless of how recent the last one is. */
	replacingExternalChanges?: boolean;
}

export interface BackupInfo {
	directory: string;
	count: number;
	/** ISO timestamp of the newest backup, null when there are none */
	newest: string | null;
	totalBytes: number;
}

export interface IElectronAPI {
	focusWindow: () => Promise<void>;
	minimizeWindow: () => Promise<void>;
	maximizeWindow: () => Promise<void>;
	closeWindow: () => Promise<void>;
	// Tells the main process whether an entry edit form holds unsaved changes,
	// so closing the window can ask before discarding them
	setUnsavedChanges: (dirty: boolean) => Promise<void>;
	onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
	saveFile: (data: Uint8Array, backup?: BackupOptions) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	saveToFile: (filePath: string, data: Uint8Array, backup?: BackupOptions) => Promise<{ success: boolean; error?: string }>;
	getBackupInfo: (filePath: string) => Promise<BackupInfo>;
	revealBackups: (filePath: string) => Promise<{ success: boolean; error?: string }>;
	saveAttachment: (name: string, data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>;
	// Resolves a dropped/picked File to its real path and grants it in the
	// main process (vault files only); null when the File has no disk path
	registerDroppedFile: (file: File) => Promise<string | null>;
	openFile: () => Promise<{ filePath: string; canceled: boolean }>;
	readFile: (filePath: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
	selectKeyFile: () => Promise<{ canceled: boolean; filePath?: string }>;
	statFile: (filePath: string) => Promise<{ success: boolean; mtimeMs?: number; size?: number; error?: string }>;
	getLastDatabasePath: () => Promise<string | null>;
	saveLastDatabasePath: (path: string) => Promise<boolean>;
	isBiometricsAvailable: () => Promise<boolean>;
	getBiometricsInfo: () => Promise<{
		available: boolean;
		/** 'hardware': the OS releases the key only after a biometric check it
		 *  enforces itself. The only backend a password is ever stored under. */
		backend: 'hardware' | 'none';
		biometryType: string;
		/** Set when the sensor works but this build cannot use it (macOS,
		 *  unsigned build), so the unlock screen can say why the option is absent */
		unavailableReason?: string;
	}>;
	enableBiometrics: (dbPath: string, password: string) => Promise<{ success: boolean; error?: string }>;
	getBiometricPassword: (dbPath: string) => Promise<{
		success: boolean;
		password?: string;
		error?: string;
		/** The stored credential is still usable; only this attempt failed. */
		retry?: boolean;
	}>;
	// hardwareBacked reports what protects the stored password now: false for
	// a legacy macOS blob awaiting its re-seal at the next unlock
	hasBiometricsEnabled: (dbPath: string) => Promise<{ success: boolean; enabled: boolean; hardwareBacked?: boolean; error?: string }>;
	disableBiometrics: (dbPath: string) => Promise<{ success: boolean; error?: string }>;
	// Copying runs in the main process so it can carry the macOS pasteboard
	// markers and so a quit mid-countdown can still take the secret back
	copySecret: (text: string, clearSeconds?: number) => Promise<{ success: boolean; error?: string }>;
	clearClipboard: () => Promise<{ success: boolean; error?: string }>;
	getContentProtection: () => Promise<{ supported: boolean; enabled: boolean }>;
	setContentProtection: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean; error?: string }>;
	argon2: (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => Promise<ArrayBuffer>;
	openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
	getPlatform: () => Promise<string>;
	on: (channel: string, callback: (...args: any[]) => void) => () => void;
	checkEmailBreaches: (email: string) => Promise<any[]>;
	setHibpApiKey: (key: string | null) => Promise<{ success: boolean; error?: string }>;
	hasHibpApiKey: () => Promise<boolean>;
	// Favicon bytes for icon promotion; fails rather than returning placeholders
	fetchFavicon: (host: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
	isHardwareKeyPresent: () => Promise<boolean>;
	listHardwareKeys: () => Promise<{ keys: HardwareKeyInfo[]; blocked: boolean }>;
	hardwareKeyChallenge: (serial: number | null, slot: 1 | 2, challenge: ArrayBuffer) => Promise<{ success: boolean; response?: Uint8Array; error?: string }>;
	showNotification: (options: { title: string, body: string }) => Promise<void>;
	reportVaultOpened: (filePath: string) => Promise<{ duplicate: boolean }>;
	reportVaultClosed: () => Promise<void>;
	qrCaptureScreens: () => Promise<{ success: boolean; images?: string[]; error?: string }>;
	browserIntegrationRespond: (id: number, result: unknown) => void;
	getBrowserIntegrationStatus: () => Promise<{ supported: boolean; enabled: boolean; running: boolean; socketPath: string }>;
	setBrowserIntegrationEnabled: (enabled: boolean) => Promise<{ success: boolean; running: boolean; written?: string[]; error?: string }>;
	installBrowserManifests: () => Promise<{ success: boolean; written: string[]; error?: string }>;
	// Fire and forget into the main process log file; see errorReporting.ts
	logError: (message: string) => void;
	revealLogs: () => Promise<{ success: boolean; error?: string }>;
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
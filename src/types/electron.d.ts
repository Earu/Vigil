export type UpdateStatus =
	| { state: 'disabled' }
	| { state: 'idle' }
	| { state: 'checking' }
	| { state: 'up-to-date' }
	| { state: 'downloading'; version: string }
	| { state: 'downloaded'; version: string }
	| { state: 'error'; message: string };

export interface SshAgentIdentity {
	type: string;
	fingerprint: string;
	comment: string;
}

export interface SshAgentStatus {
	running: boolean;
	socketPath: string | null;
	identities: SshAgentIdentity[];
	// Fingerprints Vigil itself put in the agent, across all open vaults
	addedByVigil: string[];
	error?: string;
}

export interface SshKeyFailure {
	success: false;
	error: string;
	// format: not a key file; passphrase: the entry password does not open
	// it; unsupported: a key type or cipher this build cannot handle; agent:
	// the agent refused or is not there
	code: 'format' | 'passphrase' | 'unsupported' | 'agent';
}

export type SshKeyInspection = {
	success: true;
	type: string;
	fingerprint: string;
	comment: string;
	encrypted: boolean;
	// Set when the key is protected and the passphrase given does not open
	// it; type and fingerprint may still be known from the file's clear part
	passphraseError?: string;
} | SshKeyFailure;

export interface SshAgentAddOptions {
	comment: string;
	confirm: boolean;
	lifetimeSeconds?: number;
	removeAtClose: boolean;
}

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
	// Files beside the vault that a sync client named as copies of it; each
	// comes read-granted so the renderer can open and compare it
	listConflictCopies: (vaultPath: string) => Promise<Array<{ copyPath: string; hash: string }>>;
	// Moves a listed or watcher-reported conflict copy to the trash; refused
	// for any other path
	trashConflictCopy: (copyPath: string) => Promise<{ success: boolean; error?: string }>;
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
	// armed says an unlock attempt could release a password right now: false
	// for a session-scoped vault after a restart, until a password unlock
	// re-arms it
	hasBiometricsEnabled: (dbPath: string) => Promise<{ success: boolean; enabled: boolean; armed?: boolean; error?: string }>;
	disableBiometrics: (dbPath: string) => Promise<{ success: boolean; error?: string }>;
	// Windows only: whether Hello unlock survives a restart (persistent blob)
	// or the sealed password lives only in Vigil's memory for the session
	getBiometricsConfig: () => Promise<{ requirePasswordAfterRestart: boolean }>;
	setBiometricsConfig: (config: { requirePasswordAfterRestart: boolean }) => Promise<{ success: boolean; error?: string }>;
	// Copying runs in the main process so it can carry the macOS pasteboard
	// markers and so a quit mid-countdown can still take the secret back
	copySecret: (text: string, clearSeconds?: number) => Promise<{ success: boolean; error?: string }>;
	clearClipboard: () => Promise<{ success: boolean; error?: string }>;
	getContentProtection: () => Promise<{ supported: boolean; enabled: boolean }>;
	setContentProtection: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean; error?: string }>;
	argon2: (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => Promise<ArrayBuffer>;
	openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
	getPlatform: () => Promise<string>;
	// Main-to-renderer events. Among them 'vault-file-changed', sent by the
	// vault watcher (electron/src/vault-watcher.ts) with
	// { path, hash, mtimeMs } once the open vault's file has changed on disk,
	// and 'vault-conflict-copy' with { path, copyPath, hash } when a sync
	// client's conflict copy of the vault appears beside it
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
	sshAgentStatus: () => Promise<SshAgentStatus>;
	sshAgentInspectKey: (data: Uint8Array, passphrase?: string) => Promise<SshKeyInspection>;
	sshAgentAddKey: (data: Uint8Array, passphrase: string, options: SshAgentAddOptions) => Promise<{ success: true; fingerprint: string } | SshKeyFailure>;
	sshAgentRemoveKey: (data: Uint8Array, passphrase?: string) => Promise<{ success: true } | SshKeyFailure>;
	// Decoded in the main process: the renderer gets the QR text, never the
	// screenshot
	qrCaptureScreens: () => Promise<{ success: boolean; text?: string; error?: string }>;
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
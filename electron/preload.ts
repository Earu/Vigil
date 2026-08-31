import { contextBridge, ipcRenderer } from 'electron'
import { IElectronAPI } from '../src/types/electron'

const api: IElectronAPI = {
	focusWindow: () => ipcRenderer.invoke('focus-window'),
	minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
	maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
	closeWindow: () => ipcRenderer.invoke('close-window'),
	onMaximizeChange: (callback) => {
		const wrapper = (_: unknown, maximized: boolean) => callback(maximized)
		ipcRenderer.on('maximize-change', wrapper)
		return () => { ipcRenderer.off('maximize-change', wrapper) }
	},
	saveFile: (data) => ipcRenderer.invoke('save-file', data),
	saveToFile: (filePath, data) => ipcRenderer.invoke('save-to-file', filePath, data),
	saveAttachment: (name, data) => ipcRenderer.invoke('save-attachment', name, data),
	getFilePath: (path) => ipcRenderer.invoke('get-file-path', path),
	openFile: () => ipcRenderer.invoke('open-file'),
	readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
	selectKeyFile: () => ipcRenderer.invoke('select-key-file'),
	statFile: (filePath) => ipcRenderer.invoke('stat-file', filePath),
	getLastDatabasePath: () => ipcRenderer.invoke('get-last-database-path'),
	saveLastDatabasePath: (path) => ipcRenderer.invoke('save-last-database-path', path),
	isBiometricsAvailable: () => ipcRenderer.invoke('is-biometrics-available'),
	enableBiometrics: (dbPath, password) => ipcRenderer.invoke('enable-biometrics', dbPath, password),
	getBiometricPassword: (dbPath) => ipcRenderer.invoke('get-biometric-password', dbPath),
	hasBiometricsEnabled: (dbPath) => ipcRenderer.invoke('has-biometrics-enabled', dbPath),
	disableBiometrics: (dbPath) => ipcRenderer.invoke('disable-biometrics', dbPath),
	clearClipboard: () => ipcRenderer.invoke('clear-clipboard'),
	argon2: (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => ipcRenderer.invoke('argon2', password, salt, memory, iterations, length, parallelism, type, version),
	openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
	getPlatform: () => ipcRenderer.invoke('get-platform'),
	// Function identity does not survive the context bridge, so removal by
	// callback is impossible: `on` returns the unsubscribe function instead
	on: (channel: string, callback: (...args: any[]) => void) => {
		const wrapper = (_: unknown, ...args: unknown[]) => callback(...args)
		ipcRenderer.on(channel, wrapper)
		return () => { ipcRenderer.off(channel, wrapper) }
	},
	checkEmailBreaches: (email: string, apiKey: string) => ipcRenderer.invoke('check-email-breaches', email, apiKey),
	isHardwareKeyPresent: () => ipcRenderer.invoke('hardware-key-present'),
	listHardwareKeys: () => ipcRenderer.invoke('hardware-key-list'),
	hardwareKeyChallenge: (serial, slot, challenge) => ipcRenderer.invoke('hardware-key-challenge', serial, slot, challenge),
	showNotification: (options) => ipcRenderer.invoke('show-notification', options),
	reportVaultOpened: (filePath: string) => ipcRenderer.invoke('vault-opened', filePath),
	reportVaultClosed: () => ipcRenderer.invoke('vault-closed'),
	qrCaptureScreens: () => ipcRenderer.invoke('qr-capture-screens'),
	browserIntegrationRespond: (id: number, result: unknown) => ipcRenderer.send('browser-integration-response', { id, result }),
	getBrowserIntegrationStatus: () => ipcRenderer.invoke('browser-integration-status'),
	setBrowserIntegrationEnabled: (enabled: boolean) => ipcRenderer.invoke('browser-integration-set-enabled', enabled),
	installBrowserManifests: () => ipcRenderer.invoke('browser-integration-install-manifests'),
	getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
	checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
	installUpdate: () => ipcRenderer.invoke('install-update')
}

contextBridge.exposeInMainWorld('electron', api)
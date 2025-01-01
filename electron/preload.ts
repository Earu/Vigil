import { contextBridge, ipcRenderer } from 'electron'
import { IElectronAPI } from '../src/types/electron'

const api: IElectronAPI = {
	minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
	maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
	closeWindow: () => ipcRenderer.invoke('close-window'),
	onMaximizeChange: (callback) => {
		ipcRenderer.on('maximize-change', (_, maximized) => callback(maximized))
	},
	saveFile: (data) => ipcRenderer.invoke('save-file', data),
	saveToFile: (filePath, data) => ipcRenderer.invoke('save-to-file', filePath, data),
	getFilePath: (path) => ipcRenderer.invoke('get-file-path', path),
	openFile: () => ipcRenderer.invoke('open-file'),
	readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
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
	on: (channel: string, callback: Function) => ipcRenderer.on(channel, (_, ...args) => callback(...args)),
	off: (channel: string, callback: Function) => ipcRenderer.off(channel, (_, ...args) => callback(...args)),
}

contextBridge.exposeInMainWorld('electron', api)
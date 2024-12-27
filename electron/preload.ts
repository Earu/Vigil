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
	saveLastDatabasePath: (path) => ipcRenderer.invoke('save-last-database-path', path)
}

contextBridge.exposeInMainWorld('electron', api)
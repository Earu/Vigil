import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
	minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
	maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
	closeWindow: () => ipcRenderer.invoke('close-window'),
	onMaximizeChange: (callback: (maximized: boolean) => void) => {
		ipcRenderer.on('window-maximized', (_, maximized) => callback(maximized))
	},
	saveFile: (buffer: Buffer) => ipcRenderer.invoke('save-file', buffer)
})
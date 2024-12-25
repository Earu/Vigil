interface Window {
	electron?: {
		minimizeWindow: () => Promise<void>
		maximizeWindow: () => Promise<void>
		closeWindow: () => Promise<void>
		onMaximizeChange: (callback: (maximized: boolean) => void) => void
		saveFile: (data: Uint8Array) => Promise<{ success: boolean; filePath?: string; error?: string }>
	}
}
interface Window {
	electron?: {
		minimizeWindow: () => Promise<void>
		maximizeWindow: () => Promise<void>
		closeWindow: () => Promise<void>
		onMaximizeChange: (callback: (maximized: boolean) => void) => void
	}
}
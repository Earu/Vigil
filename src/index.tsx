import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import * as kdbxweb from 'kdbxweb';
import { IElectronAPI } from './types/electron';
import { installErrorReporting } from './errorReporting';
import { userSettingsService } from './services/UserSettingsService';

// Before anything else can fail
installErrorReporting();

// A HIBP API key stored in localStorage by an older version moves to the OS
// keychain; fire-and-forget, the sweep gates on the keychain either way
void userSettingsService.migrateHibpApiKey();

// On Linux the frameless window has no system-drawn rounded corners, so the
// window is made transparent there and the corners are rounded in CSS
if (window.electron) {
	window.electron.getPlatform().then(platform => {
		if (platform === 'linux') {
			document.documentElement.classList.add('linux-frameless');
			window.electron?.onMaximizeChange((maximized: boolean) => {
				document.documentElement.classList.toggle('maximized', maximized);
			});
		}
	});
}

// Initialize Argon2 implementation for kdbxweb. At module load, not deferred:
// an unlock can happen within the first second (biometrics, drag-and-drop)
// and would hit kdbxweb's throwing stub if this were still pending
if (window?.electron) {
	kdbxweb.CryptoEngine.argon2 = async (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
		const electron = window.electron as IElectronAPI;
		const hash = await electron.argon2(password, salt, memory, iterations, length, parallelism, type, version);
		return new Uint8Array(hash);
	}
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>
);
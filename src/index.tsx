import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import * as kdbxweb from 'kdbxweb';
import { IElectronAPI } from './types/electron';

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

// Initialize Argon2 implementation for kdbxweb
setTimeout(() => {
	if (!window?.electron) return;

	kdbxweb.CryptoEngine.argon2 = async (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, version: number) => {
		const electron = window.electron as IElectronAPI;
		const hash = await electron.argon2(password, salt, memory, iterations, length, parallelism, type, version);
		return new Uint8Array(hash);
	}
}, 1000);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>
);
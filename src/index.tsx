import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import * as kdbxweb from 'kdbxweb';
import { IElectronAPI } from './types/electron';

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
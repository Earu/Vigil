import { useState, useEffect } from 'react';
import { Background } from './components/Background';
import { PasswordView } from './components/PasswordView';
import * as kdbxweb from 'kdbxweb';
import { Database } from './types/database';
import './App.css';
import { TitleBar } from './components/TitleBar';
import { ToastContainer } from './components/Toast/Toast';
import { AuthenticationView } from './components/Authentication/AuthenticationView';
import { KeepassDatabaseService } from './services/KeepassDatabaseService';
import { ThemeProvider } from './contexts/ThemeContext';
import { Settings } from './components/Settings/Settings';
import { BreachCheckService } from './services/BreachCheckService';
import { userSettingsService } from './services/UserSettingsService';
import { ExtensionAuthModal } from './components/Authentication/ExtensionAuthModal';
import { ExtensionService } from './services/ExtensionService';

function App() {
	const [database, setDatabase] = useState<Database | null>(null);
	const [searchQuery, setSearchQuery] = useState('');
	const [kdbxDb, setKdbxDb] = useState<kdbxweb.Kdbx | null>(null);
	const [showInitialBreachReport, setShowInitialBreachReport] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [autoLockEnabled, setAutoLockEnabled] = useState<boolean>(userSettingsService.getAutoLockEnabled());
	const [autoLockDuration, setAutoLockDuration] = useState<number>(userSettingsService.getAutoLockDuration());
	const [recentlyLocked, setRecentlyLocked] = useState(false);
	const [showAuthPrompt, setShowAuthPrompt] = useState(false);
	const [pendingExtensionRequest, setPendingExtensionRequest] = useState<{requestId: string, connectionId: string, appName: string} | null>(null);
	const [hasBiometrics, setHasBiometrics] = useState(false);

	const handleLockEvent = () => {
		if (database) {
			handleLock();
		}
	};

	const handleExtensionMessage = async (message: any) => {
		console.info('API', message.type, message.requestId);

		if (!database || !kdbxDb) {
			window.electron?.respondToExtension(message.requestId, {
				error: 'No database is currently open'
			});
			return;
		}

		try {
			switch (message.type) {
				case 'GET_AVAILABLE_ENTRIES': {
					const availableEntries = await ExtensionService.handleGetAvailableEntries(database);
					window.electron?.respondToExtension(message.requestId, {
						data: availableEntries
					});
					break;
				}
				case 'GET_CREDENTIALS': {
					const credentials = await ExtensionService.handleGetCredentials(database, message.data.id);
					window.electron?.respondToExtension(message.requestId, {
						data: credentials
					});
					break;
				}
				case 'UPDATE_ENTRY': {
					const updatedEntry = await ExtensionService.handleUpdateEntry(database, message.data.id, message.data.url);
					handleDatabaseChange(database);
					window.electron?.respondToExtension(message.requestId, {
						data: updatedEntry
					});
					break;
				}
			}
		} catch (error: any) {
			window.electron?.respondToExtension(message.requestId, {
				error: error.message
			});
		}
	};

	const handleAuthRequest = async (request: { requestId: string, connectionId: string, appName: string }) => {
		console.warn('API', request.requestId, request.connectionId, request.appName);

		if (!database || !kdbxDb) {
			window.electron?.respondToExtension(request.requestId, {
				error: 'No database is currently open'
			});
			return;
		}

		const dbPath = KeepassDatabaseService.getPath();
		if (!dbPath) {
			window.electron?.respondToExtension(request.requestId, {
				error: 'No database path available'
			});
			return;
		}

		const hasBiometrics = await window.electron?.hasBiometricsEnabled(dbPath);
		setPendingExtensionRequest(request);
		setHasBiometrics(!!hasBiometrics?.enabled);
		setShowAuthPrompt(true);
	};

	// Register events only once when component mounts
	useEffect(() => {
		const onTriggerLock = () => handleLockEvent();
		const onExtensionMessage = (message: any) => handleExtensionMessage(message);
		const onAuthRequest = (request: { requestId: string, connectionId: string, appName: string }) => handleAuthRequest(request);

		if (!database) {
			return () => {
				window.electron?.off('trigger-lock', onTriggerLock);
				window.electron?.off('extension-message', onExtensionMessage);
				window.electron?.off('request-authentication', onAuthRequest);
			};
		}

		window.electron?.on('trigger-lock', onTriggerLock);
		window.electron?.on('extension-message', onExtensionMessage);
		window.electron?.on('request-authentication', onAuthRequest);

		return () => {
			window.electron?.off('trigger-lock', onTriggerLock);
			window.electron?.off('extension-message', onExtensionMessage);
			window.electron?.off('request-authentication', onAuthRequest);
		};
	}, [database]); // Empty dependency array means this only runs once

	const handleAuthenticationSuccess = async (password?: string) => {
		if (pendingExtensionRequest && database) {
			try {
				if (password) {
					const dbPath = KeepassDatabaseService.getPath();
					if (!dbPath) throw new Error('No database path available');
					await ExtensionService.verifyDatabaseAccess(dbPath, password);
				}

				await ExtensionService.handleAuthenticationSuccess(pendingExtensionRequest.connectionId);
			} catch (error) {
				await ExtensionService.handleAuthenticationFailure(pendingExtensionRequest.requestId);
				throw error; // Re-throw to let the modal handle the error
			}
		}
		setShowAuthPrompt(false);
		setPendingExtensionRequest(null);
	};

	const handleAuthenticationFailure = async () => {
		if (pendingExtensionRequest) {
			await ExtensionService.handleAuthenticationFailure(pendingExtensionRequest.requestId);
		}
		setShowAuthPrompt(false);
		setPendingExtensionRequest(null);
	};

	// Auto-lock timer effect
	useEffect(() => {
		if (!database || !autoLockEnabled) {
			return;
		}

		const autoLockDuration = userSettingsService.getAutoLockDuration() * 60 * 1000; // Convert minutes to milliseconds
		const timer = setTimeout(() => {
			handleLock();
			(window as any).showToast?.({
				message: 'Database was locked automatically',
				type: 'warning',
				duration: 3000
			});
		}, autoLockDuration);

		return () => clearTimeout(timer);
	}, [database, autoLockEnabled, autoLockDuration]);

	const handleDatabaseOpen = (database: Database, kdbxDb: kdbxweb.Kdbx, showBreachReport?: boolean) => {
		setDatabase(database);
		setKdbxDb(kdbxDb);
		setShowInitialBreachReport(!!showBreachReport);
		window.electron?.setDatabasePath(KeepassDatabaseService.getPath() || null);
	};

	const handleLock = () => {
		setDatabase(null);
		setKdbxDb(null);
		setShowInitialBreachReport(false);
		KeepassDatabaseService.setPath(undefined);
		window.electron?.setDatabasePath(null);
		BreachCheckService.cancelChecks();
		setRecentlyLocked(true);
		setTimeout(() => setRecentlyLocked(false), 1000);
	};

	const handleDatabaseChange = async (updatedDatabase: Database) => {
		setDatabase(updatedDatabase);

		try {
			if (!kdbxDb) {
				throw new Error('Database not loaded');
			}

			await KeepassDatabaseService.saveDatabase(updatedDatabase, kdbxDb);
		} catch (err) {
			console.error('Failed to save database:', err);
			// Show error toast
			(window as any).showToast?.({
				message: 'Failed to save database',
				type: 'error'
			});
		}
	};

	const content = database ? (
		<>
			<TitleBar
				inPasswordView={true}
				onLock={handleLock}
				searchQuery={searchQuery}
				onSearch={setSearchQuery}
				onOpenSettings={() => setShowSettings(true)}
			/>
			<PasswordView
				database={database}
				searchQuery={searchQuery}
				onDatabaseChange={handleDatabaseChange}
				showInitialBreachReport={showInitialBreachReport}
			/>
			{showAuthPrompt && (
				<ExtensionAuthModal
					onAllow={handleAuthenticationSuccess}
					onDisallow={handleAuthenticationFailure}
					hasBiometrics={hasBiometrics}
					appName={pendingExtensionRequest?.appName || 'Unknown Application'}
				/>
			)}
		</>
	) : (
		<div className="app">
			<Background />
			<TitleBar onOpenSettings={() => setShowSettings(true)} />
			<AuthenticationView
				onDatabaseOpen={handleDatabaseOpen}
				recentlyLocked={recentlyLocked}
			/>
		</div>
	);

	return (
		<ThemeProvider>
			{content}
			<Settings
				isOpen={showSettings}
				onClose={() => setShowSettings(false)}
				kdbxDb={kdbxDb}
				autoLockEnabled={autoLockEnabled}
				setAutoLockEnabled={(enabled) => {
					setAutoLockEnabled(enabled);
					userSettingsService.setAutoLockEnabled(enabled);
				}}
				autoLockDuration={autoLockDuration}
				setAutoLockDuration={(duration) => {
					setAutoLockDuration(duration);
					userSettingsService.setAutoLockDuration(duration);
				}}
				onDatabaseChange={() => {
					if (database && kdbxDb) {
						// Get the updated database state after CSV import
						const updatedDatabase = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
						handleDatabaseChange(updatedDatabase);
					}
				}}
			/>
			<ToastContainer />
		</ThemeProvider>
	);
}

export default App;


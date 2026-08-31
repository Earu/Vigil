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

function App() {
	const [database, setDatabase] = useState<Database | null>(null);
	const [searchQuery, setSearchQuery] = useState('');
	const [kdbxDb, setKdbxDb] = useState<kdbxweb.Kdbx | null>(null);
	const [showInitialBreachReport, setShowInitialBreachReport] = useState(false);
	// Incremented each time the title bar shield button is clicked; PasswordView
	// opens the security report whenever it changes
	const [securityReportRequestId, setSecurityReportRequestId] = useState(0);
	const [showSettings, setShowSettings] = useState(false);
	const [autoLockEnabled, setAutoLockEnabled] = useState<boolean>(userSettingsService.getAutoLockEnabled());
	const [autoLockDuration, setAutoLockDuration] = useState<number>(userSettingsService.getAutoLockDuration());

	useEffect(() => {
		const handleUpdateStatus = (status: { state: string; version?: string }) => {
			if (status.state === 'downloaded') {
				(window as any).showToast?.({
					message: `Update v${status.version} downloaded; it will be installed when the app closes`,
					type: 'success',
					duration: 6000
				});
			}
		};
		const unsubscribe = window.electron?.on('update-status', handleUpdateStatus);
		return () => unsubscribe?.();
	}, []);

	useEffect(() => {
		const handleLockEvent = () => {
			if (database) {
				handleLock();
			}
		};

		const unsubscribe = window.electron?.on('trigger-lock', handleLockEvent);

		return () => unsubscribe?.();
	}, [database]);

	// Auto-lock on inactivity: the countdown restarts on user input, so an
	// open session in active use never locks mid-work
	useEffect(() => {
		if (!database || !autoLockEnabled) {
			return;
		}

		const duration = autoLockDuration * 60 * 1000;
		const lock = () => {
			handleLock();
			(window as any).showToast?.({
				message: 'Database was locked automatically',
				type: 'warning',
				duration: 3000
			});
		};

		let timer = setTimeout(lock, duration);
		let lastReset = Date.now();
		const handleActivity = () => {
			// mousemove fires constantly; restarting the timer once a second is plenty
			if (Date.now() - lastReset < 1000) return;
			lastReset = Date.now();
			clearTimeout(timer);
			timer = setTimeout(lock, duration);
		};

		const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;
		events.forEach(name => window.addEventListener(name, handleActivity, { passive: true }));

		return () => {
			clearTimeout(timer);
			events.forEach(name => window.removeEventListener(name, handleActivity));
		};
	}, [database, autoLockEnabled, autoLockDuration]);

	const handleDatabaseOpen = async (database: Database, kdbxDb: kdbxweb.Kdbx, showBreachReport?: boolean) => {
		// One window per vault: if another window already has this file open,
		// hand over to it instead of racing it for writes
		const path = KeepassDatabaseService.getPath();
		if (path && window.electron) {
			const result = await window.electron.reportVaultOpened(path).catch(() => ({ duplicate: false }));
			if (result.duplicate) {
				KeepassDatabaseService.setPath(undefined);
				(window as any).showToast?.({
					message: 'This vault is already open in another window',
					type: 'warning',
					duration: 4000
				});
				return;
			}
		}

		setDatabase(database);
		setKdbxDb(kdbxDb);
		setShowInitialBreachReport(!!showBreachReport);
	};

	const handleLock = () => {
		setDatabase(null);
		setKdbxDb(null);
		setShowInitialBreachReport(false);
		KeepassDatabaseService.setPath(undefined);
		BreachCheckService.cancelChecks();
		window.electron?.reportVaultClosed().catch(() => {});
	};

	const handleDatabaseChange = async (updatedDatabase: Database) => {
		setDatabase(updatedDatabase);

		try {
			if (!kdbxDb) {
				throw new Error('Database not loaded');
			}

			await KeepassDatabaseService.saveDatabase(updatedDatabase, kdbxDb);
			// Re-read the model from the kdbx so state produced during the save
			// (history revisions, retention trims) reaches the UI
			setDatabase(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
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
				onOpenSecurityReport={() => setSecurityReportRequestId(id => id + 1)}
			/>
			<PasswordView
				database={database}
				searchQuery={searchQuery}
				onDatabaseChange={handleDatabaseChange}
				showInitialBreachReport={showInitialBreachReport}
				securityReportRequestId={securityReportRequestId}
			/>
		</>
	) : (
		<div className="app">
			<Background />
			<TitleBar onOpenSettings={() => setShowSettings(true)} />
			<AuthenticationView
				onDatabaseOpen={handleDatabaseOpen}
				onBreachCheckComplete={() => setShowInitialBreachReport(true)}
			/>
		</div>
	);

	return (
		<ThemeProvider>
			{content}
			<div className="app-version">v{__APP_VERSION__}</div>
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


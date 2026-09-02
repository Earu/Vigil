import { useState, useEffect, useRef } from 'react';
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
import { BreachStatusStore } from './services/BreachStatusStore';
import { EmailBreachStatusStore } from './services/EmailBreachStatusStore';
import { ClipboardService } from './services/ClipboardService';
import { BreachCacheCrypto } from './services/BreachCacheCrypto';
import { userSettingsService } from './services/UserSettingsService';
import { BrowserIntegrationService } from './services/BrowserIntegrationService';
import { BrowserPairingDialog } from './components/BrowserPairingDialog';
import { PasskeyConsentDialog } from './components/PasskeyConsentDialog';
import { SetLoginConsentDialog } from './components/SetLoginConsentDialog';
import { AccessConsentDialog } from './components/AccessConsentDialog';
import { HardwareKeyTouchDialog } from './components/HardwareKeyTouchDialog';
import { PasskeyConsentRequest, SetLoginConsentRequest, AccessConsentRequest, AccessConsentResponse } from './services/BrowserIntegrationService';

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
	const [pairingRequest, setPairingRequest] = useState<{ fingerprint: string; existingNames: string[]; resolve: (name: string | null) => void } | null>(null);
	const [passkeyConsent, setPasskeyConsent] = useState<{ request: PasskeyConsentRequest; resolve: (credentialId: string | null) => void } | null>(null);
	const [setLoginConsent, setSetLoginConsent] = useState<{ request: SetLoginConsentRequest; resolve: (allowed: boolean) => void } | null>(null);
	const [accessConsent, setAccessConsent] = useState<{ request: AccessConsentRequest; resolve: (response: AccessConsentResponse | null) => void } | null>(null);
	const [hardwareKeyTouchPending, setHardwareKeyTouchPending] = useState(false);
	// True while EntryDetails holds unsaved edits. PasswordView reads it to
	// guard navigation; locking reads it so a lock the user asked for does not
	// throw those edits away without saying so
	const entryDirty = useRef(false);
	// True after a save failed: the in-memory vault holds changes the file does
	// not. Locking or closing while set loses them, so both prompt first, and
	// the next successful save clears it
	const saveFailed = useRef(false);

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
				// Power events and the browser extension's lock-database: nobody
				// is necessarily at the screen to answer a prompt, and a lock
				// that waits on one is a lock that never happens
				handleLock({ force: true });
			}
		};

		const unsubscribe = window.electron?.on('trigger-lock', handleLockEvent);

		return () => unsubscribe?.();
	}, [database]);

	// The YubiKey is blinking and waiting for a touch (unlock or save with a
	// touch-required challenge-response slot). The prompt closes on the
	// paired done event, whichever way the challenge ends
	useEffect(() => {
		const unsubTouch = window.electron?.on('hardware-key-touch', () => {
			window.electron?.focusWindow();
			setHardwareKeyTouchPending(true);
		});
		const unsubDone = window.electron?.on('hardware-key-touch-done', () => {
			setHardwareKeyTouchPending(false);
		});

		return () => {
			unsubTouch?.();
			unsubDone?.();
		};
	}, []);

	// Auto-lock on inactivity: the countdown restarts on user input, so an
	// open session in active use never locks mid-work
	useEffect(() => {
		if (!database || !autoLockEnabled) {
			return;
		}

		const duration = autoLockDuration * 60 * 1000;
		const lock = () => {
			// The user walked away, so this cannot stop to ask about unsaved
			// edits either: a prompt here would leave the vault open all night
			handleLock({ force: true });
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

	// Answer credential/pairing requests forwarded by the browser
	// integration socket server in the main process
	useEffect(() => {
		if (!database || !kdbxDb || !window.electron) return;

		const handler = async ({ id, action, payload }: { id: number; action: string; payload: any }) => {
			try {
				const result = await BrowserIntegrationService.handleRequest(action, payload, {
					database,
					kdbxDb,
					saveDatabase: async () => {
						await handleDatabaseChange(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
					},
					requestPairing: (fingerprint, existingNames) => new Promise((resolve) => {
						window.electron?.focusWindow().catch(() => {});
						setPairingRequest({
							fingerprint,
							existingNames,
							resolve: (name) => {
								setPairingRequest(null);
								resolve(name);
							},
						});
					}),
					requestPasskeyConsent: (request) => new Promise((resolve) => {
						window.electron?.focusWindow().catch(() => {});
						setPasskeyConsent({
							request,
							resolve: (credentialId) => {
								setPasskeyConsent(null);
								resolve(credentialId);
							},
						});
					}),
					requestSetLoginConsent: (request) => new Promise((resolve) => {
						window.electron?.focusWindow().catch(() => {});
						setSetLoginConsent({
							request,
							resolve: (allowed) => {
								setSetLoginConsent(null);
								resolve(allowed);
							},
						});
					}),
					requestAccessConsent: (request) => new Promise((resolve) => {
						window.electron?.focusWindow().catch(() => {});
						setAccessConsent({
							request,
							resolve: (response) => {
								setAccessConsent(null);
								resolve(response);
							},
						});
					}),
				});
				window.electron?.browserIntegrationRespond(id, result);
				if (action === 'associate' && !result.errorCode) {
					// Settings listens for this to refresh its pairing list live
					window.dispatchEvent(new CustomEvent('vigil-browser-associations-changed'));
				}
			} catch (err) {
				console.error('Browser integration request failed:', err);
				window.electron?.browserIntegrationRespond(id, { errorCode: 17 });
			}
		};

		const unsubscribe = window.electron.on('browser-integration-request', handler);
		return () => unsubscribe();
	}, [database, kdbxDb]);

	const handleDatabaseOpen = async (database: Database, kdbxDb: kdbxweb.Kdbx, showBreachReport?: boolean) => {
		// Ahead of the await below, not after it. The caller starts the breach
		// sweep without waiting on this function, and the sweep reads caches
		// that are sealed under a key derived from this vault. Deriving it one
		// IPC round trip later would leave every unlock reading a cold cache
		// and re-checking the whole vault against HaveIBeenPwned
		BreachCacheCrypto.unlock(kdbxDb);

		// The vault records which revisions each replica has archived, so that
		// a merge can still tell an unseen revision from a deleted one after a
		// lock or a restart has emptied what was only held in memory
		KeepassDatabaseService.restoreHistoryNotes(kdbxDb);

		// One window per vault: if another window already has this file open,
		// hand over to it instead of racing it for writes
		const path = KeepassDatabaseService.getPath();
		if (path && window.electron) {
			const result = await window.electron.reportVaultOpened(path).catch(() => ({ duplicate: false }));
			if (result.duplicate) {
				BreachCacheCrypto.lock();
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

	// force skips the unsaved-edits prompt, for locks that have to happen
	// whatever the answer would be (idle timeout, suspend, screen lock)
	const handleLock = (options?: { force?: boolean }) => {
		if (!options?.force && entryDirty.current &&
			!window.confirm('This entry has unsaved changes. Discard them and lock?')) {
			return;
		}
		if (!options?.force && saveFailed.current &&
			!window.confirm('The last save failed, so recent changes are not in the file. Discard them and lock?')) {
			return;
		}
		entryDirty.current = false;
		saveFailed.current = false;
		window.electron?.setUnsavedChanges(false).catch(() => {});

		// Anything the vault put in the clipboard goes now rather than at the
		// end of its countdown
		ClipboardService.clearNow();
		setDatabase(null);
		setKdbxDb(null);
		setShowInitialBreachReport(false);
		KeepassDatabaseService.setPath(undefined);
		BreachCheckService.cancelChecks();
		// Flush whatever the sweep produced, then drop the key so nothing can
		// read the cache back while the vault is closed
		BreachStatusStore.flush();
		EmailBreachStatusStore.flush();
		BreachCacheCrypto.lock();
		window.electron?.reportVaultClosed().catch(() => {});
	};

	// Rethrows on failure so callers that answer someone (browser integration)
	// report the save as failed instead of claiming success. UI callers go
	// through handleDatabaseChangeFromUi below, which swallows the rejection:
	// the save path has already toasted, and the flags set here keep the close
	// and lock guards honest about the unpersisted state
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
			saveFailed.current = false;
			window.electron?.setUnsavedChanges(entryDirty.current).catch(() => {});
		} catch (err) {
			console.error('Failed to save database:', err);
			saveFailed.current = true;
			window.electron?.setUnsavedChanges(true).catch(() => {});
			throw err;
		}
	};

	const handleDatabaseChangeFromUi = (updatedDatabase: Database) => {
		handleDatabaseChange(updatedDatabase).catch(() => {});
	};

	const content = database ? (
		<>
			<TitleBar
				inPasswordView={true}
				onLock={() => handleLock()}
				searchQuery={searchQuery}
				onSearch={setSearchQuery}
				onOpenSettings={() => setShowSettings(true)}
				onOpenSecurityReport={() => setSecurityReportRequestId(id => id + 1)}
			/>
			<PasswordView
				database={database}
				searchQuery={searchQuery}
				onDatabaseChange={handleDatabaseChangeFromUi}
				showInitialBreachReport={showInitialBreachReport}
				securityReportRequestId={securityReportRequestId}
				entryDirty={entryDirty}
				saveFailed={saveFailed}
				onSearch={setSearchQuery}
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
						handleDatabaseChangeFromUi(updatedDatabase);
					}
				}}
			/>
			<ToastContainer />
			{pairingRequest && (
				<BrowserPairingDialog
					fingerprint={pairingRequest.fingerprint}
					existingNames={pairingRequest.existingNames}
					onSubmit={(name) => pairingRequest.resolve(name)}
					onCancel={() => pairingRequest.resolve(null)}
				/>
			)}
			{passkeyConsent && (
				<PasskeyConsentDialog
					request={passkeyConsent.request}
					onSubmit={(credentialId) => passkeyConsent.resolve(credentialId)}
					onCancel={() => passkeyConsent.resolve(null)}
				/>
			)}
			{setLoginConsent && (
				<SetLoginConsentDialog
					request={setLoginConsent.request}
					onSubmit={() => setLoginConsent.resolve(true)}
					onCancel={() => setLoginConsent.resolve(false)}
				/>
			)}
			{accessConsent && (
				<AccessConsentDialog
					request={accessConsent.request}
					onSubmit={(allowedIds, remember) => accessConsent.resolve({ allowedIds, remember })}
					onCancel={() => accessConsent.resolve(null)}
				/>
			)}
			{hardwareKeyTouchPending && <HardwareKeyTouchDialog />}
		</ThemeProvider>
	);
}

export default App;


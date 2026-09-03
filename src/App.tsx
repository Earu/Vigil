import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
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
import { HaveIBeenPwnedService } from './services/HaveIBeenPwnedService';
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
import { SaveConflictDialog } from './components/SaveConflictDialog';
import { PasskeyConsentRequest, SetLoginConsentRequest, AccessConsentRequest, AccessConsentResponse } from './services/BrowserIntegrationService';
import { consentQueue } from './services/ConsentQueue';

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
	// Browser integration consent dialogs, one on screen at a time; see
	// services/ConsentQueue.ts for why they queue rather than replace
	const consent = useSyncExternalStore(consentQueue.subscribe, consentQueue.getSnapshot);
	const [hardwareKeyTouchPending, setHardwareKeyTouchPending] = useState(false);
	// True while EntryDetails holds unsaved edits. PasswordView reads it to
	// guard navigation; locking reads it so a lock the user asked for does not
	// throw those edits away without saying so
	const entryDirty = useRef(false);
	// True after a save failed: the in-memory vault holds changes the file does
	// not. Locking or closing while set loses them, so both prompt first, and
	// the next successful save clears it
	const saveFailed = useRef(false);
	// Saves currently running. The edit form drops its dirty flag the moment
	// it hands an entry over, but the write takes an Argon2-sized pause; the
	// main process must keep treating the window as unsaved until it lands,
	// or a close in that gap loses the edit without a prompt
	const savesInFlight = useRef(0);

	// The strength estimator (zxcvbn, roughly half the bundle) is split out
	// and fetched after first paint, so it is ready by the time a password
	// field needs it without slowing the unlock screen down
	useEffect(() => {
		const timer = setTimeout(() => {
			HaveIBeenPwnedService.preloadStrengthEstimator().catch(() => {});
		}, 1500);
		return () => clearTimeout(timer);
	}, []);

	// The save path asks about unmergeable external changes through this
	// resolver; the dialog rides the consent queue like the browser prompts.
	// requestId 0: no main-process request stands behind it, so no timeout
	// can cancel it
	useEffect(() => {
		KeepassDatabaseService.conflictResolver = (message) => {
			window.electron?.focusWindow().catch(() => {});
			return consentQueue.enqueue<{ message: string }, boolean>('save-conflict', 0, { message }, false);
		};
		return () => { KeepassDatabaseService.conflictResolver = undefined; };
	}, []);

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
	// integration socket server in the main process.
	//
	// The model is read through a ref and the effect is keyed on kdbxDb
	// alone: a save replaces the database object (twice), and re-running
	// this effect on that would clear the consent queue mid-save, silently
	// answering any dialog on screen with its cancel value. kdbxDb only
	// changes on unlock and lock, which are exactly the moments the
	// subscription and the queue should reset
	const databaseRef = useRef<Database | null>(null);
	useEffect(() => { databaseRef.current = database; }, [database]);

	useEffect(() => {
		if (!kdbxDb || !window.electron) return;

		const handler = async ({ id, action, payload }: { id: number; action: string; payload: any }) => {
			const database = databaseRef.current;
			if (!database) return;
			try {
				const result = await BrowserIntegrationService.handleRequest(action, payload, {
					database,
					kdbxDb,
					saveDatabase: async () => {
						await handleDatabaseChange(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
					},
					requestPairing: (fingerprint, existingNames) => {
						window.electron?.focusWindow().catch(() => {});
						return consentQueue.enqueue<{ fingerprint: string; existingNames: string[] }, string | null>('pairing', id, { fingerprint, existingNames }, null);
					},
					requestPasskeyConsent: (request) => {
						window.electron?.focusWindow().catch(() => {});
						return consentQueue.enqueue<PasskeyConsentRequest, string | null>('passkey', id, request, null);
					},
					requestSetLoginConsent: (request) => {
						window.electron?.focusWindow().catch(() => {});
						return consentQueue.enqueue<SetLoginConsentRequest, boolean>('set-login', id, request, false);
					},
					requestAccessConsent: (request) => {
						window.electron?.focusWindow().catch(() => {});
						return consentQueue.enqueue<AccessConsentRequest, AccessConsentResponse | null>('access', id, request, null);
					},
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
		// Main gave up waiting (its timeout passed and it already answered the
		// browser with a denial): the dialog closes so a late click cannot save
		// a login or mint a passkey the browser was told it did not get
		const unsubscribeCancel = window.electron.on('browser-integration-cancel', ({ id }: { id: number }) => consentQueue.cancel(id));
		return () => {
			unsubscribe();
			unsubscribeCancel();
			consentQueue.clear();
		};
	}, [kdbxDb]);

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

		savesInFlight.current++;
		try {
			if (!kdbxDb) {
				throw new Error('Database not loaded');
			}

			await KeepassDatabaseService.saveDatabase(updatedDatabase, kdbxDb);
			// Re-read the model from the kdbx so state produced during the save
			// (history revisions, retention trims) reaches the UI
			setDatabase(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
			saveFailed.current = false;
			// This save is still counted; anything beyond it is another one
			// still running
			window.electron?.setUnsavedChanges(entryDirty.current || savesInFlight.current > 1).catch(() => {});
		} catch (err) {
			console.error('Failed to save database:', err);
			// A save that merged changes from disk and then failed to write
			// leaves them in the kdbx only; show them, so the next edit
			// starts from a model that has them
			if (kdbxDb && KeepassDatabaseService.hasUnseenMergedChanges()) {
				setDatabase(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
			}
			saveFailed.current = true;
			window.electron?.setUnsavedChanges(true).catch(() => {});
			throw err;
		} finally {
			savesInFlight.current--;
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
				savesInFlight={savesInFlight}
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
			{/* Keyed on the item id: a different request is a different dialog,
			    never one that inherits the previous request's typed state */}
			{consent?.kind === 'pairing' && (
				<BrowserPairingDialog
					key={consent.id}
					fingerprint={(consent.payload as { fingerprint: string }).fingerprint}
					existingNames={(consent.payload as { existingNames: string[] }).existingNames}
					onSubmit={(name) => consentQueue.settle(consent.id, name)}
					onCancel={() => consentQueue.settle(consent.id, null)}
				/>
			)}
			{consent?.kind === 'passkey' && (
				<PasskeyConsentDialog
					key={consent.id}
					request={consent.payload as PasskeyConsentRequest}
					onSubmit={(credentialId) => consentQueue.settle(consent.id, credentialId)}
					onCancel={() => consentQueue.settle(consent.id, null)}
				/>
			)}
			{consent?.kind === 'set-login' && (
				<SetLoginConsentDialog
					key={consent.id}
					request={consent.payload as SetLoginConsentRequest}
					onSubmit={() => consentQueue.settle(consent.id, true)}
					onCancel={() => consentQueue.settle(consent.id, false)}
				/>
			)}
			{consent?.kind === 'access' && (
				<AccessConsentDialog
					key={consent.id}
					request={consent.payload as AccessConsentRequest}
					onSubmit={(allowedIds, remember) => consentQueue.settle<AccessConsentResponse | null>(consent.id, { allowedIds, remember })}
					onCancel={() => consentQueue.settle(consent.id, null)}
				/>
			)}
			{consent?.kind === 'save-conflict' && (
				<SaveConflictDialog
					key={consent.id}
					message={(consent.payload as { message: string }).message}
					onOverwrite={() => consentQueue.settle(consent.id, true)}
					onCancel={() => consentQueue.settle(consent.id, false)}
				/>
			)}
			{hardwareKeyTouchPending && <HardwareKeyTouchDialog />}
		</ThemeProvider>
	);
}

export default App;


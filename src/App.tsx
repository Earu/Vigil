import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { Background } from './components/Background';
import { PasswordView } from './components/PasswordView';
import * as kdbxweb from 'kdbxweb';
import { Database } from './types/database';
import './App.css';
import { TitleBar } from './components/TitleBar';
import { ToastContainer } from './components/Toast/Toast';
import { FocusTooltip } from './components/FocusTooltip';
import { AuthenticationView } from './components/Authentication/AuthenticationView';
import { KeepassDatabaseService } from './services/KeepassDatabaseService';
import { SshAgentService } from './services/SshAgentService';
import { ThemeProvider } from './contexts/ThemeContext';
import { Settings } from './components/Settings/Settings';
import { BreachCheckService } from './services/BreachCheckService';
import { HaveIBeenPwnedService } from './services/HaveIBeenPwnedService';
import { BreachStatusStore } from './services/BreachStatusStore';
import { EmailBreachStatusStore } from './services/EmailBreachStatusStore';
import { ClipboardService } from './services/ClipboardService';
import { matchesChord, dialogOpen, focusSearch, zoomAction, registerAction, runAction, ActionId } from './services/Shortcuts';
import { confirmDialog } from './services/Dialogs';
import { ConfirmDialog, ConfirmRequest } from './components/ConfirmDialog';
import { BreachCacheCrypto } from './services/BreachCacheCrypto';
import { userSettingsService } from './services/UserSettingsService';
import { BrowserIntegrationService } from './services/BrowserIntegrationService';
import { BrowserPairingDialog } from './components/BrowserPairingDialog';
import { PasskeyConsentDialog } from './components/PasskeyConsentDialog';
import { SetLoginConsentDialog } from './components/SetLoginConsentDialog';
import { AccessConsentDialog } from './components/AccessConsentDialog';
import { HardwareKeyTouchDialog } from './components/HardwareKeyTouchDialog';
import { SaveConflictDialog } from './components/SaveConflictDialog';
import { ConflictCopyDialog, ConflictCopyRequest, hasChanges } from './components/ConflictCopyDialog';
import { PasskeyConsentRequest, SetLoginConsentRequest, AccessConsentRequest, AccessConsentResponse } from './services/BrowserIntegrationService';
import { consentQueue } from './services/ConsentQueue';
import { FaviconService } from './services/FaviconService';

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

	// The file changed on disk while the vault is open (a sync client landing
	// another machine's edit): merge it in now rather than at the next save.
	// An entry being edited keeps its draft across the model rebuild
	// (EntryDetails re-seeds only when not editing); if the other side edited
	// the same entry, the draft wins on save and the merged values sit in
	// that entry's history
	useEffect(() => {
		if (!kdbxDb || !window.electron) return;

		const handler = async ({ path, hash, mtimeMs }: { path: string; hash: string; mtimeMs: number }) => {
			// An event for a vault this window no longer shows, or never did
			if (path !== KeepassDatabaseService.getPath() || kdbxDbRef.current !== kdbxDb) return;
			try {
				const result = await KeepassDatabaseService.reloadExternalChanges(kdbxDb, { hash, mtimeMs });
				if (kdbxDbRef.current !== kdbxDb) return;
				if (result === 'merged') {
					setDatabase(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
				} else if (result === 'failed') {
					(window as any).showToast?.({
						message: 'The database changed on disk but could not be merged; your next save will ask what to do',
						type: 'warning',
						duration: 8000
					});
				}
			} catch (err) {
				console.error('Failed to reload external changes:', err);
			}
		};

		const unsubscribe = window.electron.on('vault-file-changed', handler);
		return () => unsubscribe();
	}, [kdbxDb]);

	// Conflict copies a sync client left beside the vault: the ones already
	// there when the vault opened (asked for once) and the ones that appear
	// while it is open (the watcher). Each is opened with this vault's
	// credentials and matched by identity before its changes are merged in;
	// the user then decides whether to save and trash the copy. One at a time:
	// two copies merging into the same kdbx concurrently would race
	useEffect(() => {
		if (!kdbxDb || !window.electron) return;
		const vaultPath = KeepassDatabaseService.getPath();
		if (!vaultPath) return;
		const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
		const vaultName = baseName(vaultPath);

		let chain: Promise<void> = Promise.resolve();
		const absorb = async (copyPath: string, hash: string) => {
			if (kdbxDbRef.current !== kdbxDb) return;
			const copyName = baseName(copyPath);
			const result = await KeepassDatabaseService.absorbConflictCopy(kdbxDb, copyPath, hash);
			if (kdbxDbRef.current !== kdbxDb) return;
			if (result.outcome === 'locked') {
				(window as any).showToast?.({
					message: `${copyName} looks like a copy of this vault, but this vault's password does not open it`,
					type: 'warning',
					duration: 8000
				});
				return;
			}
			if (result.outcome !== 'merged') return;

			const changed = hasChanges(result.changes);
			if (changed) setDatabase(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
			window.electron?.focusWindow().catch(() => {});
			const trash = await consentQueue.enqueue<ConflictCopyRequest, boolean>(
				'conflict-copy', 0, { copyName, vaultName, changes: result.changes }, false);
			if (kdbxDbRef.current !== kdbxDb) return;
			if (!trash) {
				(window as any).showToast?.({
					message: changed
						? `Took the changes from ${copyName} and kept the copy`
						: `Kept ${copyName}`,
					type: 'info',
					duration: 5000
				});
				return;
			}
			// A copy that changed the vault goes only once the merged state is
			// on disk; a save that fails has already said so and leaves the
			// copy where it is. A copy that changed nothing needs no save
			if (changed) {
				try {
					await handleDatabaseChange(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
				} catch {
					return;
				}
				if (kdbxDbRef.current !== kdbxDb) return;
			}
			const trashed = await window.electron!.trashConflictCopy(copyPath);
			(window as any).showToast?.({
				message: trashed.success
					? (changed ? `Saved the changes from ${copyName} and moved it to the trash` : `Moved ${copyName} to the trash`)
					: `Could not move ${copyName} to the trash: ${trashed.error ?? 'unknown error'}`,
				type: trashed.success ? 'success' : 'warning',
				duration: 5000
			});
		};
		const enqueue = (copyPath: string, hash: string) => {
			chain = chain
				.then(() => absorb(copyPath, hash))
				.catch(err => console.error('Failed to handle a conflict copy:', err));
		};

		const unsubscribe = window.electron.on('vault-conflict-copy',
			({ path, copyPath, hash }: { path: string; copyPath: string; hash: string }) => {
				if (path === vaultPath) enqueue(copyPath, hash);
			});
		window.electron.listConflictCopies(vaultPath)
			.then(copies => { for (const copy of copies) enqueue(copy.copyPath, copy.hash); })
			.catch(err => console.error('Failed to list conflict copies:', err));
		return () => unsubscribe();
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
		kdbxDbRef.current = kdbxDb;
		// The settings modal open over the unlock screen would otherwise sit
		// on top of the vault that just opened
		setShowSettings(false);
		setShowInitialBreachReport(!!showBreachReport);

		// Entries carrying an SSH key that asked to be loaded at open go into
		// the agent now; they leave it when the vault locks (main process,
		// on vault-closed). Not awaited: a slow or absent agent must not
		// hold the vault view back
		SshAgentService.addKeysOnUnlock(database).then(report => {
			if (kdbxDbRef.current !== kdbxDb) return;
			if (report.failed.length > 0) {
				const detail = report.failed.slice(0, 3).map(f => `${f.title}: ${f.error}`).join('; ');
				(window as any).showToast?.({
					message: `SSH keys not added to the agent (${report.failed.length}). ${detail}`,
					type: 'error',
					duration: 8000
				});
			} else if (report.added > 0) {
				(window as any).showToast?.({
					message: `${report.added} SSH ${report.added === 1 ? 'key' : 'keys'} added to the agent`,
					type: 'success',
					duration: 3000
				});
			}
		}).catch(() => {});
	};

	// The vault whose session is current, for callbacks that resume after an
	// await and must not act on a vault that was locked meanwhile (a save
	// finishing, the favicon sweep). Set where the state is, not from an
	// effect, so a lock is visible to a promise resolving in the same tick
	const kdbxDbRef = useRef<kdbxweb.Kdbx | null>(null);

	// Vault-wide shortcuts. Handlers change with state, so the listener
	// reads the latest through a ref instead of re-subscribing
	const shortcutActions = useRef({ lock: () => {}, vaultOpen: false });
	useEffect(() => {
		const openSettings = () => { if (!dialogOpen()) setShowSettings(true); };
		const lock = () => { if (shortcutActions.current.vaultOpen) shortcutActions.current.lock(); };
		const search = () => { if (shortcutActions.current.vaultOpen && !dialogOpen()) focusSearch(); };
		const unregister = [registerAction('settings', openSettings), registerAction('lock', lock), registerAction('search', search)];
		// The macOS menu bar; its items name the same actions
		const unsubscribeMenu = window.electron?.on('menu-action', (id: ActionId) => {
			if (dialogOpen() && id !== 'lock') return;
			runAction(id);
		});
		const onKeyDown = (e: KeyboardEvent) => {
			const zoom = zoomAction(e);
			if (zoom) {
				e.preventDefault();
				window.electron?.zoom(zoom).catch(() => {});
				return;
			}
			if (matchesChord(e, 'Mod+,')) {
				if (dialogOpen()) return;
				e.preventDefault();
				openSettings();
				return;
			}
			if (!shortcutActions.current.vaultOpen) return;
			if (matchesChord(e, 'Mod+L')) {
				e.preventDefault();
				lock();
			} else if (matchesChord(e, 'Mod+F') && !dialogOpen()) {
				e.preventDefault();
				search();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			unsubscribeMenu?.();
			for (const stop of unregister) stop();
		};
	}, []);

	// force skips the unsaved-edits prompt, for locks that have to happen
	// whatever the answer would be (idle timeout, suspend, screen lock)
	const handleLock = async (options?: { force?: boolean }) => {
		if (!options?.force && entryDirty.current &&
			!(await confirmDialog('This entry has unsaved changes. Discard them and lock?', 'Discard and Lock'))) {
			return;
		}
		if (!options?.force && saveFailed.current &&
			!(await confirmDialog('The last save failed. Discard the unsaved changes and lock?', 'Discard and Lock'))) {
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
		kdbxDbRef.current = null;
		// Whatever the settings modal was showing belonged to this session,
		// and so did the search: it names what the user was looking at, and
		// would otherwise still be in the bar for whoever unlocks next
		setShowSettings(false);
		setSearchQuery('');
		setShowInitialBreachReport(false);
		FaviconService.reset();
		KeepassDatabaseService.setPath(undefined);
		BreachCheckService.cancelChecks();
		// Flush whatever the sweep produced, then drop the key so nothing can
		// read the cache back while the vault is closed
		BreachStatusStore.flush();
		EmailBreachStatusStore.flush();
		BreachCacheCrypto.lock();
		window.electron?.reportVaultClosed().catch(() => {});
	};
	shortcutActions.current = { lock: () => handleLock(), vaultOpen: database !== null };

	// Rethrows on failure so callers that answer someone (browser integration)
	// report the save as failed instead of claiming success. UI callers go
	// through handleDatabaseChangeFromUi below, which swallows the rejection:
	// the save path has already toasted, and the flags set here keep the close
	// and lock guards honest about the unpersisted state
	const handleDatabaseChange = async (updatedDatabase: Database) => {
		// Before setDatabase: a stale caller (a background task finishing
		// after a lock) must not put a model back on screen
		if (!kdbxDb) {
			throw new Error('Database not loaded');
		}
		setDatabase(updatedDatabase);

		savesInFlight.current++;
		try {

			await KeepassDatabaseService.saveDatabase(updatedDatabase, kdbxDb);
			// The vault was locked (or another opened) while this save ran.
			// The file was still written, to the path the save started with;
			// the decrypted model must not come back on screen, and the
			// flags below belong to the session that is open now
			if (kdbxDbRef.current !== kdbxDb) return;
			// Re-read the model from the kdbx so state produced during the save
			// (history revisions, retention trims) reaches the UI
			setDatabase(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
			saveFailed.current = false;
			// This save is still counted; anything beyond it is another one
			// still running
			window.electron?.setUnsavedChanges(entryDirty.current || savesInFlight.current > 1).catch(() => {});
		} catch (err) {
			console.error('Failed to save database:', err);
			// Same as above: the toast has said what failed, and nothing
			// else from a closed session may reach the UI or its flags
			if (kdbxDbRef.current !== kdbxDb) throw err;
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

	// Favicon promotion: fetched favicons become custom icons stored in the
	// vault, after which the network fetch for that entry stops. Debounced
	// behind the latest model; the blocked gate re-checks the edit and save
	// state before every write the sweep makes, and the ref comparison keeps
	// a sweep that outlived its vault (lock, different vault opened) from
	// saving or re-displaying the old session through this callback
	useEffect(() => {
		if (!kdbxDb || !database) return;
		const timer = setTimeout(() => {
			if (entryDirty.current || savesInFlight.current > 0) return;
			FaviconService.sweep(
				kdbxDb,
				database,
				async () => {
					if (kdbxDbRef.current !== kdbxDb) return;
					await handleDatabaseChange(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
				},
				() => entryDirty.current || savesInFlight.current > 0 || kdbxDbRef.current !== kdbxDb
			).catch(() => {});
		}, 2500);
		return () => clearTimeout(timer);
	}, [kdbxDb, database]);

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
					if (!database || !kdbxDb) return Promise.resolve(false);
					const updatedDatabase = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
					return handleDatabaseChange(updatedDatabase).then(() => true, () => false);
				}}
			/>
			<ToastContainer />
			<FocusTooltip />
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
			{consent?.kind === 'confirm' && (
				<ConfirmDialog
					key={consent.id}
					request={consent.payload as ConfirmRequest}
					onConfirm={() => consentQueue.settle(consent.id, true)}
					onCancel={() => consentQueue.settle(consent.id, false)}
				/>
			)}
			{consent?.kind === 'conflict-copy' && (
				<ConflictCopyDialog
					key={consent.id}
					request={consent.payload as ConflictCopyRequest}
					onTrash={() => consentQueue.settle(consent.id, true)}
					onKeep={() => consentQueue.settle(consent.id, false)}
				/>
			)}
			{hardwareKeyTouchPending && <HardwareKeyTouchDialog />}
		</ThemeProvider>
	);
}

export default App;


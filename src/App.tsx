import { useState, useEffect } from 'react';
import { Background } from './components/Background';
import { PasswordView } from './components/PasswordView';
import * as kdbxweb from 'kdbxweb';
import { Database, Group, Entry } from './types/database';
import './App.css';
import { TitleBar } from './components/TitleBar';
import { ToastContainer } from './components/Toast/Toast';
import { hash } from 'argon2-browser';
import { AuthenticationView } from './components/Authentication/AuthenticationView';
import { DatabasePathService } from './services/DatabasePathService';

declare var argon2: { hash: typeof hash };

// Initialize Argon2 implementation for kdbxweb
kdbxweb.CryptoEngine.argon2 = async (password: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number, _version: number) => {
	try {
		const result = await argon2.hash({
			pass: new Uint8Array(password),
			salt: new Uint8Array(salt),
			time: iterations,
			mem: memory,
			parallelism,
			type,
			hashLen: length
		});
		return result.hash;
	} catch (err) {
		console.error('Argon2 error:', err);
		throw err;
	}
};

interface SaveResult {
	success: boolean;
	filePath?: string;
	error?: string;
}

function App() {
	const [database, setDatabase] = useState<Database | null>(null);
	const [searchQuery, setSearchQuery] = useState('');
	const [kdbxDb, setKdbxDb] = useState<kdbxweb.Kdbx | null>(null);
	const [showInitialBreachReport, setShowInitialBreachReport] = useState(false);

	useEffect(() => {
		const loadArgon2 = async () => {
			await import('argon2-browser/lib/argon2.js');
		};
		loadArgon2();
	}, []);

	const handleDatabaseOpen = (database: Database, kdbxDb: kdbxweb.Kdbx, showBreachReport?: boolean) => {
		setDatabase(database);
		setKdbxDb(kdbxDb);
		setShowInitialBreachReport(!!showBreachReport);
	};

	const handleLock = () => {
		setDatabase(null);
		setKdbxDb(null);
		setShowInitialBreachReport(false);
		DatabasePathService.setPath(undefined);
	};

	const handleDatabaseChange = async (updatedDatabase: Database) => {
		setDatabase(updatedDatabase);

		try {
			if (!kdbxDb) {
				throw new Error('Database not loaded');
			}

			// Update the entries in the existing database
			const updateGroup = (group: Group, kdbxGroup: kdbxweb.KdbxGroup) => {
				// Update group name
				kdbxGroup.name = group.name;

				// Clear existing entries
				while (kdbxGroup.entries.length > 0) {
					kdbxGroup.entries.pop();
				}

				// Add updated entries
				group.entries.forEach((entry: Entry) => {
					const kdbxEntry = kdbxDb.createEntry(kdbxGroup);
					// If this is an existing entry, preserve its UUID
					if (entry.id && entry.id.length === 32) {
						const uuidBytes = new Uint8Array(16);
						for (let i = 0; i < 16; i++) {
							uuidBytes[i] = parseInt(entry.id.substr(i * 2, 2), 16);
						}
						kdbxEntry.uuid = new kdbxweb.KdbxUuid(uuidBytes);
					}
					kdbxEntry.fields.set('Title', entry.title);
					kdbxEntry.fields.set('UserName', entry.username);
					kdbxEntry.fields.set('Password', typeof entry.password === 'string'
						? kdbxweb.ProtectedValue.fromString(entry.password)
						: entry.password
					);
					if (entry.url) kdbxEntry.fields.set('URL', entry.url);
					if (entry.notes) kdbxEntry.fields.set('Notes', entry.notes);
					kdbxEntry.times.creationTime = entry.created;
					kdbxEntry.times.lastModTime = entry.modified;
				});

				// Handle subgroups
				// First, remove groups that no longer exist
				const groupIds = new Set(group.groups.map(g => g.id));
				kdbxGroup.groups = kdbxGroup.groups.filter(kg =>
					groupIds.has(kg.uuid.toString())
				);

				// Then update or create groups
				group.groups.forEach((subgroup: Group) => {
					let kdbxSubgroup = kdbxGroup.groups.find(kg => kg.uuid.toString() === subgroup.id);
					if (!kdbxSubgroup) {
						kdbxSubgroup = kdbxDb.createGroup(kdbxGroup, subgroup.name);
						// For new groups, we'll let KdbxWeb generate the UUID
						// and update our group object to match
						subgroup.id = kdbxSubgroup.uuid.toString();
					}
					updateGroup(subgroup, kdbxSubgroup);
				});
			};

			const root = kdbxDb.getDefaultGroup();
			if (root) {
				updateGroup(updatedDatabase.root, root);
			}

			// Save the updated database
			const arrayBuffer = await kdbxDb.save();

			let result: SaveResult | undefined;
			const currentPath = DatabasePathService.getPath();
			if (currentPath) {
				// If we have a path, save directly to it
				result = await window.electron?.saveToFile(currentPath, new Uint8Array(arrayBuffer));
				if (!result?.success) {
					// If direct save fails, fall back to save dialog
					result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));
					if (result?.success && result.filePath) {
						DatabasePathService.setPath(result.filePath);
					}
				}
			} else {
				// If no path, use save dialog
				result = await window.electron?.saveFile(new Uint8Array(arrayBuffer));
				if (result?.success && result.filePath) {
					DatabasePathService.setPath(result.filePath);
				}
			}

			if (!result?.success) {
				throw new Error(result?.error || 'Failed to save database');
			}

			// Show success toast
			(window as any).showToast?.({
				message: 'Database saved successfully',
				type: 'success'
			});
		} catch (err) {
			console.error('Failed to save database:', err);
			// Show error toast
			(window as any).showToast?.({
				message: 'Failed to save database',
				type: 'error'
			});
		}
	};

	if (database) {
		return (
			<>
				<TitleBar
					inPasswordView={true}
					onLock={handleLock}
					searchQuery={searchQuery}
					onSearch={setSearchQuery}
				/>
				<PasswordView
					database={database}
					searchQuery={searchQuery}
					onDatabaseChange={handleDatabaseChange}
					showInitialBreachReport={showInitialBreachReport}
				/>
				<ToastContainer />
			</>
		);
	}

	return (
		<div className="app">
			<Background />
			<TitleBar />
			<AuthenticationView onDatabaseOpen={handleDatabaseOpen} />
			<ToastContainer />
		</div>
	);
}

export default App;


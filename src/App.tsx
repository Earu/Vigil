import { useState, useEffect } from 'react';
import { Background } from './components/Background';
import { PasswordView } from './components/PasswordView';
import * as kdbxweb from 'kdbxweb';
import { Database } from './types/database';
import './App.css';
import { TitleBar } from './components/TitleBar';
import { ToastContainer } from './components/Toast/Toast';
import { AuthenticationView } from './components/Authentication/AuthenticationView';
import { DatabasePathService } from './services/DatabasePathService';
import { KeepassDatabaseService } from './services/KeepassDatabaseService';

function App() {
	const [database, setDatabase] = useState<Database | null>(null);
	const [searchQuery, setSearchQuery] = useState('');
	const [kdbxDb, setKdbxDb] = useState<kdbxweb.Kdbx | null>(null);
	const [showInitialBreachReport, setShowInitialBreachReport] = useState(false);

	useEffect(() => {
		KeepassDatabaseService.initializeArgon2();
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


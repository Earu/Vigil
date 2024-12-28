import { useState, useEffect, useRef } from 'react';
import { Entry } from '../../types/database';
import * as kdbxweb from 'kdbxweb';

interface EntryDetailsProps {
	entry: Entry | null;
	onClose: () => void;
	onSave: (entry: Entry) => void;
	isNew?: boolean;
}

export const EntryDetails = ({ entry, onClose, onSave, isNew = false }: EntryDetailsProps) => {
	const [showPassword, setShowPassword] = useState(false);
	const [isEditing, setIsEditing] = useState(isNew);
	const [clipboardTimer, setClipboardTimer] = useState<number>(0);
	const [copiedField, setCopiedField] = useState<string>('');
	const timerRef = useRef<NodeJS.Timeout>();
	const [editedEntry, setEditedEntry] = useState<Entry>(() => {
		if (isNew) {
			return {
				id: '',
				title: '',
				username: '',
				password: '',
				url: '',
				notes: '',
				created: new Date(),
				modified: new Date(),
			};
		}
		return entry || {
			id: '',
			title: '',
			username: '',
			password: '',
			url: '',
			notes: '',
			created: new Date(),
			modified: new Date(),
		};
	});

	useEffect(() => {
		if (!isNew && entry) {
			setEditedEntry(entry);
		}
	}, [entry, isNew]);

	// Add keyboard shortcut handler
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Only handle shortcuts when not in editing mode
			if (isEditing || isNew) return;

			// Check for Ctrl/Cmd key
			const isCmdOrCtrl = e.metaKey || e.ctrlKey;
			if (!isCmdOrCtrl) return;

			if (e.key === 'c') {
				e.preventDefault(); // Prevent default copy behavior
				copyToClipboard(getPasswordString(), 'Password');
			} else if (e.key === 'b') {
				e.preventDefault();
				copyToClipboard(editedEntry.username, 'Username');
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [isEditing, isNew, editedEntry]);

	// Timer cleanup effect
	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current);
			}
		};
	}, []);

	// Timer countdown effect
	useEffect(() => {
		if (clipboardTimer > 0) {
			const interval = setInterval(() => {
				setClipboardTimer((prev) => {
					if (prev <= 1) {
						clearInterval(interval);
						window.electron?.clearClipboard().catch(console.error);
						setCopiedField(''); // Clear the copied field indicator
						return 0;
					}
					return prev - 1;
				});
			}, 1000);
			timerRef.current = interval;
			return () => clearInterval(interval);
		}
	}, [clipboardTimer]);

	const copyToClipboard = async (text: string, field: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setClipboardTimer(20); // Reset timer to 20 seconds
			setCopiedField(field); // Set which field was copied
			(window as any).showToast?.({
				message: `${field} copied to clipboard`,
				type: 'success'
			});
		} catch (err) {
			console.error('Failed to copy to clipboard:', err);
			(window as any).showToast?.({
				message: 'Failed to copy to clipboard',
				type: 'error'
			});
		}
	};

	const renderCopyButton = (onClick: () => void, title: string, field: string) => (
		<>
			<button
				className="copy-button"
				onClick={onClick}
				title={title}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
				{clipboardTimer > 0 && copiedField === field && (
					<div className="clipboard-timer" style={{ '--progress': `${(clipboardTimer / 20) * 100}%` } as React.CSSProperties}>
						{clipboardTimer}s
					</div>
				)}
			</button>
		</>
	);

	const handleSave = () => {
		const updatedEntry = {
			...editedEntry,
			modified: new Date(),
			// Convert password to ProtectedValue if it's a string
			password: typeof editedEntry.password === 'string'
				? kdbxweb.ProtectedValue.fromString(editedEntry.password)
				: editedEntry.password
		};
		onSave(updatedEntry);
		setIsEditing(false);
	};

	const handleCancel = () => {
		if (isNew) {
			onClose();
		} else {
			setEditedEntry(entry || editedEntry);
			setIsEditing(false);
		}
	};

	// Get the password string value for display/editing
	const getPasswordString = () => {
		if (typeof editedEntry.password === 'string') {
			return editedEntry.password;
		}
		return editedEntry.password.getText();
	};

	// Handle password changes
	const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setEditedEntry({
			...editedEntry,
			password: e.target.value
		});
	};

	return (
		<div className="entry-details">
			<div className="entry-details-header">
				<h2>{isNew ? 'New Entry' : editedEntry.title}</h2>
				<div className="entry-details-actions">
					{!isNew && !isEditing && (
						<button
							className="edit-button"
							onClick={() => setIsEditing(true)}
							title="Edit entry"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
							</svg>
						</button>
					)}
					<button className="close-button" onClick={onClose}>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			</div>

			<div className="entry-fields">
				<div className="field-group">
					<label>Title</label>
					<div className="field-value-container">
						<input
							type="text"
							value={editedEntry.title}
							onChange={(e) => setEditedEntry({ ...editedEntry, title: e.target.value })}
							className="field-value"
							readOnly={!isEditing}
							placeholder="Enter title"
						/>
						{!isEditing && editedEntry.title && renderCopyButton(
							() => copyToClipboard(editedEntry.title, 'Title'),
							'Copy title',
							'Title'
						)}
					</div>
				</div>

				<div className="field-group">
					<label>Username</label>
					<div className="field-value-container">
						<input
							type="text"
							value={editedEntry.username}
							onChange={(e) => setEditedEntry({ ...editedEntry, username: e.target.value })}
							className="field-value monospace"
							readOnly={!isEditing}
							placeholder="Enter username"
						/>
						{!isEditing && editedEntry.username && renderCopyButton(
							() => copyToClipboard(editedEntry.username, 'Username'),
							'Copy username',
							'Username'
						)}
					</div>
				</div>

				<div className="field-group">
					<label>Password</label>
					<div className="field-value-container">
						<input
							type={showPassword ? 'text' : 'password'}
							value={getPasswordString()}
							onChange={handlePasswordChange}
							className="field-value monospace"
							readOnly={!isEditing}
							placeholder="Enter password"
						/>
						<button
							className="visibility-button"
							onClick={() => setShowPassword(!showPassword)}
							title={showPassword ? 'Hide password' : 'Show password'}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								{showPassword ? (
									<>
										<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
										<line x1="1" y1="1" x2="23" y2="23" />
									</>
								) : (
									<>
										<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
										<circle cx="12" cy="12" r="3" />
									</>
								)}
							</svg>
						</button>
						{isEditing && (
							<button
								className="generate-button"
								onClick={(e) => {
									e.preventDefault();
									const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
									const password = Array.from(crypto.getRandomValues(new Uint8Array(20)))
										.map(byte => chars[byte % chars.length])
										.join('');
									setEditedEntry({
										...editedEntry,
										password: kdbxweb.ProtectedValue.fromString(password)
									});
									setShowPassword(true);
								}}
								title="Generate password"
								type="button"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M21 2v6h-6" />
									<path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
									<path d="M3 12a9 9 0 0 0 15 6.7L21 16" />
									<path d="M21 22v-6h-6" />
								</svg>
							</button>
						)}
						{!isEditing && editedEntry.password && renderCopyButton(
							() => copyToClipboard(getPasswordString(), 'Password'),
							'Copy password',
							'Password'
						)}
					</div>
				</div>

				<div className="field-group">
					<label>URL</label>
					<div className="field-value-container">
						<input
							type="text"
							value={editedEntry.url}
							onChange={(e) => setEditedEntry({ ...editedEntry, url: e.target.value })}
							className="field-value"
							readOnly={!isEditing}
							placeholder="Enter URL"
						/>
						{!isEditing && editedEntry.url && (
							<>
								{renderCopyButton(
									() => copyToClipboard(editedEntry.url!, 'URL'),
									'Copy URL',
									'URL'
								)}
								<a
									href={editedEntry.url}
									target="_blank"
									rel="noopener noreferrer"

									className="open-button"
									title="Open URL"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
										<polyline points="15 3 21 3 21 9" />
										<line x1="10" y1="14" x2="21" y2="3" />
									</svg>
								</a>
							</>
						)}
					</div>
				</div>

				<div className="field-group">
					<label>Notes</label>
					<textarea
						value={editedEntry.notes}
						onChange={(e) => setEditedEntry({ ...editedEntry, notes: e.target.value })}
						className="field-value notes"
						readOnly={!isEditing}
						placeholder="Enter notes"
					/>
				</div>

				{(isEditing || isNew) && (
					<div className="field-group actions">
						<button className="cancel-button" onClick={handleCancel}>
							Cancel
						</button>
						<button
							className="save-button"
							onClick={handleSave}
							disabled={!editedEntry.title.trim()}
						>
							Save
						</button>
					</div>
				)}

				{!isEditing && !isNew && (
					<div className="field-group metadata">
						<div className="metadata-item">
							<label>Created</label>
							<span>{editedEntry.created.toLocaleString()}</span>
						</div>
						<div className="metadata-item">
							<label>Modified</label>
							<span>{editedEntry.modified.toLocaleString()}</span>
						</div>
					</div>
				)}
			</div>
		</div>
	);
};
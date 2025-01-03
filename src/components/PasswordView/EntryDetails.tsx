import { useState, useEffect, useRef } from 'react';
import { Entry } from '../../types/database';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';
import { BreachWarningIcon, SecurityShieldIcon } from '../../icons/status/StatusIcons';
import { CloseActionIcon, CopyActionIcon, EditActionIcon, OpenUrlActionIcon, GenerateActionIcon } from '../../icons/actions/ActionIcons';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import './EntryDetails.css';
import { PasswordGenerator } from './PasswordGenerator';
import { PasswordStrength } from '../../services/BreachStatusStore';

interface EntryDetailsProps {
	entry: Entry | null;
	onClose: () => void;
	onSave: (entry: Entry) => void;
	isNew?: boolean;
}

interface PasswordStrengthIndicatorProps {
	score: number;
	warning?: string;
	suggestions?: string[];
}

const PasswordStrengthIndicator = ({ score, warning, suggestions }: PasswordStrengthIndicatorProps) => {
	const getStrengthColor = () => {
		switch (score) {
			case 0: return '#dc2626'; // red-600
			case 1: return '#dc2626'; // red-600
			case 2: return '#f59e0b'; // amber-500
			case 3: return '#10b981'; // emerald-500
			case 4: return '#10b981'; // emerald-500
			default: return '#94a3b8'; // gray-400
		}
	};

	const getStrengthLabel = () => {
		switch (score) {
			case 0: return 'Very Weak';
			case 1: return 'Weak';
			case 2: return 'Fair';
			case 3: return 'Strong';
			case 4: return 'Very Strong';
			default: return 'Unknown';
		}
	};

	return (
		<div className="password-strength">
			<div className="strength-bar-container">
				<div
					className="strength-bar"
					style={{
						width: `${(score + 1) * 20}%`,
						backgroundColor: getStrengthColor()
					}}
				/>
			</div>
			<div className="strength-label" style={{ color: getStrengthColor() }}>
				{getStrengthLabel()}
			</div>
			{warning && <div className="strength-warning">{warning}</div>}
			{suggestions && suggestions.length > 0 && (
				<ul className="strength-suggestions">
					{suggestions.map((suggestion, index) => (
						<li key={index}>{suggestion}</li>
					))}
				</ul>
			)}
		</div>
	);
};

export const EntryDetails = ({ entry, onClose, onSave, isNew = false }: EntryDetailsProps) => {
	const [showPassword, setShowPassword] = useState(false);
	const [isEditing, setIsEditing] = useState(isNew);
	const [clipboardTimer, setClipboardTimer] = useState<number>(0);
	const [copiedField, setCopiedField] = useState<string>('');
	const [breachStatus, setBreachStatus] = useState<{ isPwned: boolean; count: number; breachedEmail?: boolean; strength: PasswordStrength } | null>(null);
	const [passwordStrength, setPasswordStrength] = useState<{
		score: number;
		feedback: {
			warning: string;
			suggestions: string[];
		};
	} | null>(null);
	const [showPasswordGenerator, setShowPasswordGenerator] = useState(false);
	const timerRef = useRef<NodeJS.Timeout>();
	const [editedEntry, setEditedEntry] = useState<Entry>(() => {
		if (isNew) {
			return KeepassDatabaseService.createNewEntry();
		}
		return entry || KeepassDatabaseService.createNewEntry();
	});

	useEffect(() => {
		if (!isNew && entry) {
			setEditedEntry(entry);
			setIsEditing(false);
			// Check breach status when entry changes
			const databasePath = KeepassDatabaseService.getPath();
			if (databasePath) {
				const status = BreachCheckService.getEntryBreachStatus(databasePath, entry.id);
				setBreachStatus(status);

				// Check password strength
				const password = KeepassDatabaseService.getPasswordString(entry.password);
				HaveIBeenPwnedService.checkPassword(password).then(result => {
					setPasswordStrength(result.strength);
				});
			}
		} else if (isNew) {
			setEditedEntry(KeepassDatabaseService.createNewEntry());
			setIsEditing(true);
			setBreachStatus(null);
			setPasswordStrength(null);
		}
	}, [entry, isNew]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (isEditing || isNew) return;

			const isCmdOrCtrl = e.metaKey || e.ctrlKey;
			if (!isCmdOrCtrl) return;

			if (e.key === 'c') {
				e.preventDefault();
				copyToClipboard(KeepassDatabaseService.getPasswordString(editedEntry.password), 'Password');
			} else if (e.key === 'b') {
				e.preventDefault();
				copyToClipboard(editedEntry.username, 'Username');
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [isEditing, isNew, editedEntry]);

	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (clipboardTimer > 0) {
			const interval = setInterval(() => {
				setClipboardTimer((prev) => {
					if (prev <= 1) {
						clearInterval(interval);
						window.electron?.clearClipboard().catch(console.error);
						setCopiedField('');
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
			setClipboardTimer(20);
			setCopiedField(field);
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
				<CopyActionIcon />
				{clipboardTimer > 0 && copiedField === field && (
					<div className="clipboard-timer" style={{ '--progress': `${(clipboardTimer / 20) * 100}%` } as React.CSSProperties}>
						{clipboardTimer}s
					</div>
				)}
			</button>
		</>
	);

	const handleSave = () => {
		const updatedEntry = KeepassDatabaseService.prepareEntryForSave(editedEntry);
		onSave(updatedEntry);
		setIsEditing(false);
	};

	const handleCancel = () => {
		if (isNew) {
			onClose();
		} else {
			setEditedEntry(entry || KeepassDatabaseService.createNewEntry());
			setIsEditing(false);
		}
	};

	const handlePasswordChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const newPassword = e.target.value;
		setEditedEntry({
			...editedEntry,
			password: newPassword
		});

		const result = await HaveIBeenPwnedService.checkPassword(newPassword);
		setPasswordStrength(result.strength);
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
							<EditActionIcon />
						</button>
					)}
					<button className="close-button" onClick={onClose}>
						<CloseActionIcon />
					</button>
				</div>
			</div>

			{breachStatus?.isPwned && !isNew && !isEditing && (
				<div className="breach-warning-header">
					<BreachWarningIcon className="breach-warning-icon" />
					<div className="breach-warning-content">
						<h3>Password Compromised</h3>
						<p>This password has appeared in {breachStatus.count.toLocaleString()} data {breachStatus.count === 1 ? 'breach' : 'breaches'}. You should change it as soon as possible.</p>
					</div>
				</div>
			)}

			{!breachStatus?.isPwned && !isNew && !isEditing && editedEntry.username && breachStatus?.breachedEmail && (
				<div className="weak-password-warning-header">
					<SecurityShieldIcon className="weak-password-warning-icon" />
					<div className="weak-password-warning-content">
						<h3>Email Address Exposed</h3>
						<p>The email address associated with this entry has been found in recent data breaches. Consider using a different email address or monitoring for suspicious activity.</p>
					</div>
				</div>
			)}

			{passwordStrength && passwordStrength.score < 3 && !isNew && !isEditing && (
				<div className="weak-password-warning-header">
					<SecurityShieldIcon className="weak-password-warning-icon" />
					<div className="weak-password-warning-content">
						<h3>Weak Password</h3>
						<p>{passwordStrength.feedback.warning || 'This password is considered weak. Consider using a stronger password to improve security.'}</p>
					</div>
				</div>
			)}

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
							value={KeepassDatabaseService.getPasswordString(editedEntry.password)}
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
							{showPassword ? <HidePasswordIcon /> : <ShowPasswordIcon />}
						</button>
						{isEditing && (
							<button
								className="generate-button"
								onClick={(e) => {
									e.preventDefault();
									setShowPasswordGenerator(true);
								}}
								title="Generate password"
								type="button"
							>
								<GenerateActionIcon />
							</button>
						)}
						{!isEditing && editedEntry.password && renderCopyButton(
							() => copyToClipboard(KeepassDatabaseService.getPasswordString(editedEntry.password), 'Password'),
							'Copy password',
							'Password'
						)}
					</div>
					{passwordStrength && (isEditing || isNew) && (
						<PasswordStrengthIndicator
							score={passwordStrength.score}
							warning={passwordStrength.feedback.warning}
							suggestions={passwordStrength.feedback.suggestions}
						/>
					)}
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
								<button
									onClick={() => window.electron?.openExternal(editedEntry.url!)}
									className="open-button"
									title="Open URL"
								>
									<OpenUrlActionIcon />
								</button>
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

				{showPasswordGenerator && (
					<PasswordGenerator
						onClose={() => setShowPasswordGenerator(false)}
						onSave={(password) => {
							setEditedEntry({
								...editedEntry,
								password
							});
							setShowPassword(true);
							HaveIBeenPwnedService.checkPassword(password.getText()).then(result => {
								setPasswordStrength(result.strength);
							});
							setShowPasswordGenerator(false);
						}}
						currentPassword={KeepassDatabaseService.getPasswordString(editedEntry.password)}
					/>
				)}
			</div>
		</div>
	);
};
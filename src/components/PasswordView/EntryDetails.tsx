import { useState, useEffect, useRef, useMemo } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Entry, EntryVersion, Attachment, CustomField } from '../../types/database';
import { TotpService } from '../../services/TotpService';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';
import { BreachWarningIcon, SecurityShieldIcon, ExpiredClockIcon } from '../../icons/status/StatusIcons';
import { CloseActionIcon, CopyActionIcon, EditActionIcon, OpenUrlActionIcon, GenerateActionIcon, AttachmentActionIcon, DownloadActionIcon, AddActionIcon, ChevronActionIcon, RefreshActionIcon } from '../../icons/actions/ActionIcons';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import './EntryDetails.css';
import { PasswordGenerator } from './PasswordGenerator';
import { PasswordStrength } from '../../services/BreachStatusStore';

interface EntryDetailsProps {
	entry: Entry | null;
	onClose: () => void;
	onSave: (entry: Entry) => void;
	isNew?: boolean;
	onDirtyChange?: (dirty: boolean) => void;
}

const fieldText = (value: string | kdbxweb.ProtectedValue | undefined): string =>
	value === undefined ? '' : KeepassDatabaseService.getFieldString(value);

// Whether the edit form holds changes that would be lost on discard
const entryModified = (edited: Entry, original: Entry): boolean => {
	if (edited.title !== original.title) return true;
	if (edited.username !== original.username) return true;
	if (fieldText(edited.password) !== fieldText(original.password)) return true;
	if ((edited.url ?? '') !== (original.url ?? '')) return true;
	if ((edited.notes ?? '') !== (original.notes ?? '')) return true;
	if (!!edited.expires !== !!original.expires) return true;
	if ((edited.expiryTime?.getTime() ?? 0) !== (original.expiryTime?.getTime() ?? 0)) return true;

	if (edited.attachments.length !== original.attachments.length) return true;
	if (edited.attachments.some((a, i) => a.name !== original.attachments[i].name || a.data !== original.attachments[i].data)) return true;

	if (edited.customFields.length !== original.customFields.length) return true;
	return edited.customFields.some((f, i) => {
		const o = original.customFields[i];
		return f.key !== o.key || f.protected !== o.protected || fieldText(f.value) !== fieldText(o.value);
	});
};

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

export const EntryDetails = ({ entry, onClose, onSave, isNew = false, onDirtyChange }: EntryDetailsProps) => {
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
	const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
	const [showVersionPassword, setShowVersionPassword] = useState(false);
	const [revealedCustomFields, setRevealedCustomFields] = useState<Set<number>>(new Set());
	const [totpCode, setTotpCode] = useState<string>('');
	const [totpSecondsLeft, setTotpSecondsLeft] = useState<number>(0);
	const [totpInput, setTotpInput] = useState('');
	const [totpError, setTotpError] = useState('');
	const timerRef = useRef<NodeJS.Timeout>();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const lastCopiedText = useRef('');
	const [editedEntry, setEditedEntry] = useState<Entry>(() => {
		if (isNew) {
			return KeepassDatabaseService.createNewEntry();
		}
		return entry || KeepassDatabaseService.createNewEntry();
	});

	useEffect(() => {
		setExpandedVersion(null);
		setShowVersionPassword(false);
		setRevealedCustomFields(new Set());
		setTotpInput('');
		setTotpError('');
		if (!isNew && entry) {
			setEditedEntry(entry);
			setIsEditing(false);
			// Check breach status when entry changes
			const databasePath = KeepassDatabaseService.getPath();
			if (databasePath) {
				const status = BreachCheckService.getEntryBreachStatus(databasePath, entry.id);
				setBreachStatus(status);

				// Check password strength locally (no network call)
				const password = KeepassDatabaseService.getPasswordString(entry.password);
				setPasswordStrength(HaveIBeenPwnedService.checkPasswordStrength(password));
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
				// Don't let a pending clear die with the component (entry
				// closed or database locked while the countdown ran)
				clearCopiedValue();
			}
		};
	}, []);

	// Clear the clipboard only when it still holds what we put there; the
	// user may have copied something else since. If the read fails, clear
	// anyway rather than risk leaving a password around.
	const clearCopiedValue = async () => {
		try {
			const current = await navigator.clipboard.readText();
			if (current !== lastCopiedText.current) return;
		} catch { /* fall through to clear */ }
		window.electron?.clearClipboard().catch(console.error);
	};

	useEffect(() => {
		if (clipboardTimer > 0) {
			const interval = setInterval(() => {
				setClipboardTimer((prev) => {
					if (prev <= 1) {
						clearInterval(interval);
						clearCopiedValue();
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
			lastCopiedText.current = text;
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
		const updatedEntry = KeepassDatabaseService.prepareEntryForSave({
			...editedEntry,
			// Nameless fields cannot be stored in the kdbx
			customFields: editedEntry.customFields
				.map(f => ({ ...f, key: f.key.trim() }))
				.filter(f => f.key.length > 0),
		});
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

	const handleAddAttachments = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files || files.length === 0) return;

		const newAttachments: Attachment[] = [];
		for (const file of Array.from(files)) {
			newAttachments.push({ name: file.name, data: await file.arrayBuffer() });
		}

		setEditedEntry(prev => ({
			...prev,
			attachments: [
				// A new file with the same name replaces the old one
				...prev.attachments.filter(a => !newAttachments.some(n => n.name === a.name)),
				...newAttachments
			]
		}));

		e.target.value = '';
	};

	const handleRemoveAttachment = (name: string) => {
		setEditedEntry(prev => ({
			...prev,
			attachments: prev.attachments.filter(a => a.name !== name)
		}));
	};

	const handleDownloadAttachment = async (attachment: Attachment) => {
		const bytes = KeepassDatabaseService.getAttachmentBytes(attachment);
		const result = await window.electron?.saveAttachment(attachment.name, bytes);
		if (result?.success) {
			(window as any).showToast?.({
				message: `Saved ${attachment.name}`,
				type: 'success'
			});
		} else if (result?.error && result.error !== 'Save cancelled') {
			(window as any).showToast?.({
				message: `Failed to save ${attachment.name}`,
				type: 'error'
			});
		}
	};

	const toLocalInputValue = (date?: Date): string => {
		if (!date) return '';
		const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
		return local.toISOString().slice(0, 16);
	};

	const handleExpiresToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
		const expires = e.target.checked;
		setEditedEntry({
			...editedEntry,
			expires,
			// sensible default when turning expiry on for the first time
			expiryTime: expires
				? (editedEntry.expiryTime ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))
				: editedEntry.expiryTime,
		});
	};

	const handleAddCustomField = () => {
		setEditedEntry(prev => ({
			...prev,
			customFields: [...prev.customFields, { key: '', value: '', protected: false }]
		}));
	};

	const handleRemoveCustomField = (index: number) => {
		setEditedEntry(prev => ({
			...prev,
			customFields: prev.customFields.filter((_, i) => i !== index)
		}));
	};

	const handleCustomFieldChange = (index: number, patch: Partial<CustomField>) => {
		setEditedEntry(prev => ({
			...prev,
			customFields: prev.customFields.map((f, i) => i === index ? { ...f, ...patch } : f)
		}));
	};

	const toggleCustomFieldReveal = (index: number) => {
		setRevealedCustomFields(prev => {
			const next = new Set(prev);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			return next;
		});
	};

	const isDirty = useMemo(() => {
		if (!isEditing && !isNew) return false;
		const baseline = !isNew && entry ? entry : KeepassDatabaseService.createNewEntry();
		return entryModified(editedEntry, baseline);
	}, [editedEntry, entry, isNew, isEditing]);

	useEffect(() => {
		onDirtyChange?.(isDirty);
	}, [isDirty]);

	// Unmount always means the form is gone; leave no stale dirty flag behind
	useEffect(() => () => { onDirtyChange?.(false); }, []);

	const handleClose = () => {
		if (isDirty && !window.confirm('Discard unsaved changes to this entry?')) return;
		onClose();
	};

	const totpConfig = useMemo(
		() => TotpService.getConfig(editedEntry.customFields),
		[editedEntry.customFields]
	);

	// TOTP fields get dedicated UI; keep them out of the generic custom field
	// list but preserve original indices for the handlers
	const visibleCustomFields = useMemo(
		() => editedEntry.customFields
			.map((field, index) => ({ field, index }))
			.filter(({ field }) => !TotpService.isTotpKey(field.key)),
		[editedEntry.customFields]
	);

	useEffect(() => {
		if (!totpConfig) {
			setTotpCode('');
			return;
		}
		let cancelled = false;
		const tick = async () => {
			try {
				const code = await TotpService.generateCode(totpConfig);
				if (!cancelled) {
					setTotpCode(code);
					setTotpSecondsLeft(TotpService.secondsRemaining(totpConfig));
				}
			} catch {
				if (!cancelled) setTotpCode('');
			}
		};
		tick();
		const interval = setInterval(tick, 1000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [totpConfig]);

	const handleAddTotp = () => {
		const config = TotpService.parseUserInput(totpInput);
		if (!config) {
			setTotpError('Enter a base32 secret or an otpauth:// URI');
			return;
		}
		setEditedEntry(prev => ({
			...prev,
			customFields: [
				...prev.customFields.filter(f => !TotpService.isTotpKey(f.key)),
				{
					key: 'otp',
					value: TotpService.buildOtpAuthUri(config, prev.title),
					protected: true,
				},
			],
		}));
		setTotpInput('');
		setTotpError('');
	};

	const handleRemoveTotp = () => {
		setEditedEntry(prev => ({
			...prev,
			customFields: prev.customFields.filter(f => !TotpService.isTotpKey(f.key)),
		}));
	};

	const handleRestoreVersion = (version: EntryVersion) => {
		const restored: Entry = {
			...editedEntry,
			title: version.title,
			username: version.username,
			password: version.password,
			url: version.url,
			notes: version.notes,
			attachments: version.attachments,
			expires: version.expires,
			expiryTime: version.expiryTime,
			customFields: version.customFields,
		};
		// Saved like a normal edit, so the pre-restore state becomes a new revision
		onSave(KeepassDatabaseService.prepareEntryForSave(restored));
		setExpandedVersion(null);
		(window as any).showToast?.({
			message: `Restored version from ${version.modified.toLocaleString()}`,
			type: 'success'
		});
	};

	const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newPassword = e.target.value;
		setEditedEntry({
			...editedEntry,
			password: newPassword
		});

		setPasswordStrength(HaveIBeenPwnedService.checkPasswordStrength(newPassword));
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
					<button className="entry-close-button" onClick={handleClose}>
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

			{!isNew && !isEditing && KeepassDatabaseService.isEntryExpired(editedEntry) && (
				<div className="breach-warning-header expired-warning-header">
					<ExpiredClockIcon className="breach-warning-icon" />
					<div className="breach-warning-content">
						<h3>Entry Expired</h3>
						<p>This entry expired on {editedEntry.expiryTime?.toLocaleString()}. Consider rotating the credential.</p>
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

				{!isEditing && totpConfig && totpCode && (
					<div className="field-group">
						<label>One-Time Code</label>
						<div className="field-value-container">
							<div className="totp-display">
								<span className="totp-code">
									{totpCode.slice(0, Math.ceil(totpCode.length / 2))}&thinsp;{totpCode.slice(Math.ceil(totpCode.length / 2))}
								</span>
								<span className={`totp-countdown ${totpSecondsLeft <= 5 ? 'expiring' : ''}`}>
									{totpSecondsLeft}s
								</span>
							</div>
							{renderCopyButton(
								() => copyToClipboard(totpCode, 'One-time code'),
								'Copy one-time code',
								'One-time code'
							)}
						</div>
						<div className="totp-progress">
							<div
								className="totp-progress-bar"
								style={{ width: `${(totpSecondsLeft / totpConfig.period) * 100}%` }}
							/>
						</div>
					</div>
				)}

				{isEditing && (
					<div className="field-group">
						<label>One-Time Password</label>
						{totpConfig ? (
							<div className="totp-configured-row">
								<span className="totp-configured-text">
									TOTP configured ({totpConfig.digits} digits, {totpConfig.period}s, {totpConfig.algorithm})
								</span>
								<button
									className="attachment-action-button remove"
									onClick={handleRemoveTotp}
									title="Remove one-time password"
									type="button"
								>
									<CloseActionIcon />
								</button>
							</div>
						) : (
							<>
								<div className="totp-add-row">
									<input
										type="text"
										className="field-value"
										value={totpInput}
										placeholder="Secret or otpauth:// URI"
										onChange={(e) => { setTotpInput(e.target.value); setTotpError(''); }}
									/>
									<button
										className="totp-add-button"
										onClick={handleAddTotp}
										disabled={!totpInput.trim()}
										type="button"
									>
										Add
									</button>
								</div>
								{totpError && <div className="totp-error">{totpError}</div>}
							</>
						)}
					</div>
				)}

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

				{(isEditing || editedEntry.expires) && (
					<div className="field-group">
						<label>Expiry</label>
						<div className="expiry-controls">
							<label className="expiry-toggle">
								<input
									type="checkbox"
									checked={!!editedEntry.expires}
									disabled={!isEditing}
									onChange={handleExpiresToggle}
								/>
								Expires on
							</label>
							{editedEntry.expires && (
								<input
									type="datetime-local"
									className="field-value expiry-input"
									value={toLocalInputValue(editedEntry.expiryTime)}
									readOnly={!isEditing}
									onChange={(e) => {
										const value = e.target.value;
										if (value) {
											setEditedEntry({ ...editedEntry, expiryTime: new Date(value) });
										}
									}}
								/>
							)}
						</div>
					</div>
				)}

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

				{!isEditing && visibleCustomFields.map(({ field, index }) => (
					<div className="field-group" key={index}>
						<label>{field.key}</label>
						<div className="field-value-container">
							<input
								type={field.protected && !revealedCustomFields.has(index) ? 'password' : 'text'}
								value={KeepassDatabaseService.getFieldString(field.value)}
								className={`field-value ${field.protected ? 'monospace' : ''}`}
								readOnly
							/>
							{field.protected && (
								<button
									className="visibility-button"
									onClick={() => toggleCustomFieldReveal(index)}
									title={revealedCustomFields.has(index) ? 'Hide value' : 'Show value'}
								>
									{revealedCustomFields.has(index) ? <HidePasswordIcon /> : <ShowPasswordIcon />}
								</button>
							)}
							{renderCopyButton(
								() => copyToClipboard(KeepassDatabaseService.getFieldString(field.value), field.key),
								`Copy ${field.key}`,
								field.key
							)}
						</div>
					</div>
				))}

				{isEditing && (
					<div className="field-group">
						<label>Custom Fields</label>
						<div className="custom-fields-list">
							{visibleCustomFields.map(({ field, index }) => (
								<div className="custom-field-row" key={index}>
									<input
										type="text"
										className="field-value custom-field-key"
										value={field.key}
										placeholder="Name"
										onChange={(e) => handleCustomFieldChange(index, { key: e.target.value })}
									/>
									<input
										type="text"
										className="field-value custom-field-value"
										value={KeepassDatabaseService.getFieldString(field.value)}
										placeholder="Value"
										onChange={(e) => handleCustomFieldChange(index, { value: e.target.value })}
									/>
									<button
										className={`custom-field-protect ${field.protected ? 'active' : ''}`}
										onClick={() => handleCustomFieldChange(index, { protected: !field.protected })}
										title={field.protected ? 'Value is protected (stored encrypted, shown masked)' : 'Protect value'}
										type="button"
									>
										<SecurityShieldIcon />
									</button>
									<button
										className="attachment-action-button remove"
										onClick={() => handleRemoveCustomField(index)}
										title="Remove field"
										type="button"
									>
										<CloseActionIcon />
									</button>
								</div>
							))}
							<button
								className="add-attachment-button"
								onClick={handleAddCustomField}
								type="button"
							>
								<AddActionIcon />
								Add field
							</button>
						</div>
					</div>
				)}

				{(isEditing || editedEntry.attachments.length > 0) && (
					<div className="field-group">
						<label>Attachments</label>
						<div className="attachments-list">
							{editedEntry.attachments.map(attachment => (
								<div className="attachment-item" key={attachment.name}>
									<AttachmentActionIcon className="attachment-icon" />
									<span className="attachment-name" title={attachment.name}>{attachment.name}</span>
									<span className="attachment-size">
										{KeepassDatabaseService.formatAttachmentSize(KeepassDatabaseService.getAttachmentSize(attachment))}
									</span>
									{!isEditing ? (
										<button
											className="attachment-action-button"
											onClick={() => handleDownloadAttachment(attachment)}
											title="Save file"
										>
											<DownloadActionIcon />
										</button>
									) : (
										<button
											className="attachment-action-button remove"
											onClick={() => handleRemoveAttachment(attachment.name)}
											title="Remove file"
										>
											<CloseActionIcon />
										</button>
									)}
								</div>
							))}
							{isEditing && (
								<>
									<button
										className="add-attachment-button"
										onClick={() => fileInputRef.current?.click()}
										type="button"
									>
										<AddActionIcon />
										Add file
									</button>
									<input
										ref={fileInputRef}
										type="file"
										multiple
										hidden
										onChange={handleAddAttachments}
									/>
								</>
							)}
						</div>
					</div>
				)}

				{(isEditing || isNew) && (
					<div className="field-group actions">
						<button className="entry-cancel-button" onClick={handleCancel}>
							Cancel
						</button>
						<button
							className="entry-save-button"
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

				{!isEditing && !isNew && editedEntry.history.length > 0 && (
					<div className="field-group">
						<label>History ({editedEntry.history.length})</label>
						<div className="history-list">
							{editedEntry.history.map((version, index) => ({ version, index })).reverse().map(({ version, index }) => (
								<div className="history-item" key={index}>
									<button
										className="history-row"
										onClick={() => {
											setShowVersionPassword(false);
											setExpandedVersion(expandedVersion === index ? null : index);
										}}
									>
										<ChevronActionIcon className={`history-chevron ${expandedVersion === index ? 'expanded' : ''}`} />
										<span className="history-date">{version.modified.toLocaleString()}</span>
										<span className="history-summary" title={version.username}>{version.username || version.title}</span>
									</button>
									{expandedVersion === index && (
										<div className="history-detail">
											<div className="history-field">
												<span className="history-field-label">Title</span>
												<span className="history-field-value">{version.title}</span>
											</div>
											<div className="history-field">
												<span className="history-field-label">Username</span>
												<span className="history-field-value monospace">{version.username}</span>
											</div>
											<div className="history-field">
												<span className="history-field-label">Password</span>
												<span className="history-field-value monospace">
													{showVersionPassword
														? KeepassDatabaseService.getPasswordString(version.password)
														: '••••••••••••'}
												</span>
												<button
													className="history-reveal-button"
													onClick={() => setShowVersionPassword(!showVersionPassword)}
													title={showVersionPassword ? 'Hide password' : 'Show password'}
												>
													{showVersionPassword ? <HidePasswordIcon /> : <ShowPasswordIcon />}
												</button>
											</div>
											{version.url && (
												<div className="history-field">
													<span className="history-field-label">URL</span>
													<span className="history-field-value">{version.url}</span>
												</div>
											)}
											{version.notes && (
												<div className="history-field">
													<span className="history-field-label">Notes</span>
													<span className="history-field-value">{version.notes}</span>
												</div>
											)}
											{version.attachments.length > 0 && (
												<div className="history-field">
													<span className="history-field-label">Files</span>
													<span className="history-field-value">{version.attachments.map(a => a.name).join(', ')}</span>
												</div>
											)}
											{version.expires && version.expiryTime && (
												<div className="history-field">
													<span className="history-field-label">Expiry</span>
													<span className="history-field-value">{version.expiryTime.toLocaleString()}</span>
												</div>
											)}
											{version.customFields.map((field, fieldIndex) => (
												<div className="history-field" key={fieldIndex}>
													<span className="history-field-label">{field.key}</span>
													<span className="history-field-value">
														{field.protected ? '••••••••••••' : KeepassDatabaseService.getFieldString(field.value)}
													</span>
												</div>
											))}
											<button
												className="history-restore-button"
												onClick={() => handleRestoreVersion(version)}
											>
												<RefreshActionIcon />
												Restore this version
											</button>
										</div>
									)}
								</div>
							))}
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
							setPasswordStrength(HaveIBeenPwnedService.checkPasswordStrength(password.getText()));
							setShowPasswordGenerator(false);
						}}
						currentPassword={KeepassDatabaseService.getPasswordString(editedEntry.password)}
					/>
				)}
			</div>
		</div>
	);
};
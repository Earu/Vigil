import React, { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import * as kdbxweb from 'kdbxweb';
import { Entry, EntryVersion, Attachment, CustomField } from '../../types/database';
import { TotpService, MigrationAccount, OtpConfig } from '../../services/TotpService';
import { QrScanService } from '../../services/QrScanService';
import { BreachCheckService } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { SshAgentService, ENABLED_KEEAGENT_SETTINGS, KeeAgentSettings } from '../../services/SshAgentService';
import type { SshKeyInspection } from '../../types/electron';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';
import { BreachWarningIcon, SecurityShieldIcon, ExpiredClockIcon } from '../../icons/status/StatusIcons';
import { CloseActionIcon, CopyActionIcon, EditActionIcon, OpenUrlActionIcon, GenerateActionIcon, AttachmentActionIcon, DownloadActionIcon, AddActionIcon, ChevronActionIcon, RefreshActionIcon, MonitorActionIcon, ClipboardActionIcon, ImageActionIcon, PasskeyActionIcon, LinkActionIcon } from '../../icons/actions/ActionIcons';
import { PasskeyService } from '../../services/PasskeyService';
import { ShowPasswordIcon, HidePasswordIcon } from '../../icons/auth/AuthIcons';
import './EntryDetails.css';
import { PasswordGenerator } from './PasswordGenerator';
import { IconPicker } from './IconPicker';
import { ItemIcon } from './ItemIcon';
import { KeePassIcon } from '../../icons/keepass/KeePassIcons';
import { FaviconService } from '../../services/FaviconService';
import { PlaceholderService } from '../../services/PlaceholderService';
import { ReferenceWizard, ReferenceFieldCode } from './ReferenceWizard';
import { PasswordStrength } from '../../services/BreachStatusStore';
import { ClipboardService } from '../../services/ClipboardService';
import { Modal } from '../Modal';
import { matchesChord, dialogOpen } from '../../services/Shortcuts';

interface EntryDetailsProps {
	entry: Entry | null;
	onClose: () => void;
	onSave: (entry: Entry) => void;
	isNew?: boolean;
	onDirtyChange?: (dirty: boolean) => void;
	// Every tag already in the vault, for the suggestion list
	allTags?: string[];
	// Clicking a tag searches for it across the vault
	onTagClick?: (tag: string) => void;
	// The panel element, so the list can hand focus to it on Enter
	panelRef?: React.RefObject<HTMLDivElement>;
	// Escape while viewing: the caller takes focus back
	onReturnFocus?: () => void;
}

// Escape leaves the panel while viewing. While editing it does nothing: the
// editor has Cancel with its own discard prompt
const isEditableTarget = (target: EventTarget | null): boolean => {
	const el = target as HTMLElement | null;
	if (!el) return false;
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !el.readOnly;
	return el instanceof HTMLSelectElement;
};

const fieldText = (value: string | kdbxweb.ProtectedValue | undefined): string =>
	value === undefined ? '' : KeepassDatabaseService.getFieldString(value);

// Whether the edit form holds changes that would be lost on discard
const entryModified = (edited: Entry, original: Entry): boolean => {
	if (edited.title !== original.title) return true;
	if (edited.username !== original.username) return true;
	if (edited.icon !== original.icon) return true;
	if ((edited.customIcon ?? '') !== (original.customIcon ?? '')) return true;
	if (!!edited.suppressFavicon !== !!original.suppressFavicon) return true;
	if (fieldText(edited.password) !== fieldText(original.password)) return true;
	if ((edited.url ?? '') !== (original.url ?? '')) return true;
	if ((edited.notes ?? '') !== (original.notes ?? '')) return true;
	if (!!edited.expires !== !!original.expires) return true;
	if ((edited.expiryTime?.getTime() ?? 0) !== (original.expiryTime?.getTime() ?? 0)) return true;

	if (edited.attachments.length !== original.attachments.length) return true;
	if (edited.attachments.some((a, i) => a.name !== original.attachments[i].name || a.data !== original.attachments[i].data)) return true;

	const editedTags = KeepassDatabaseService.normalizeTags(edited.tags ?? []);
	const originalTags = KeepassDatabaseService.normalizeTags(original.tags ?? []);
	if (editedTags.length !== originalTags.length) return true;
	if (editedTags.some((tag, i) => tag !== originalTags[i])) return true;

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

export const EntryDetails = ({ entry, onClose, onSave, isNew = false, onDirtyChange, allTags = [], onTagClick, panelRef, onReturnFocus }: EntryDetailsProps) => {
	const [showPassword, setShowPassword] = useState(false);
	const [isEditing, setIsEditing] = useState(isNew);
	const [showIconPicker, setShowIconPicker] = useState(false);
	// Which field the reference wizard is inserting into; null keeps it closed
	const [refWizardField, setRefWizardField] = useState<ReferenceFieldCode | null>(null);

	// The expanded grid belongs to one editing session; a different entry or
	// leaving edit mode folds it away
	useEffect(() => {
		if (!isEditing) setShowIconPicker(false);
		// A generated HOTP code belongs to the view it was clicked in
		if (isEditing) setHotpCode('');
		setHotpCounterDraft(null);
	}, [isEditing, entry?.id]);

	// Removing an icon from an entry with a URL also opts it out of website
	// favicons: without that, the live-fetched favicon takes the cleared
	// icon's place and the removal looks like it did nothing (and the next
	// promotion sweep would store it right back)
	const applyIconChange = (icon: number | undefined, customIcon: string | undefined) => {
		const hadIcon = editedEntry.icon !== undefined || editedEntry.customIcon !== undefined;
		const cleared = icon === undefined && customIcon === undefined && hadIcon;
		setEditedEntry({
			...editedEntry,
			icon,
			customIcon,
			suppressFavicon: cleared && editedEntry.url ? true : editedEntry.suppressFavicon,
		});
	};
	// The countdown lives in the service so it survives this panel closing
	const clipboard = useSyncExternalStore(ClipboardService.subscribe, ClipboardService.getSnapshot);
	const [breachStatus, setBreachStatus] = useState<{ isPwned: boolean; count: number; breachedEmail?: boolean; strength: PasswordStrength | null } | null>(null);
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
	// Uncommitted text in the tag box; a chip only exists once it is committed
	const [tagDraft, setTagDraft] = useState('');
	const [totpCode, setTotpCode] = useState<string>('');
	const [totpSecondsLeft, setTotpSecondsLeft] = useState<number>(0);
	const [totpInput, setTotpInput] = useState('');
	const [totpError, setTotpError] = useState('');
	// The last HOTP code generated for this entry; it stays until the user
	// leaves the entry or enters edit mode, since every generation is a
	// counter burned on the server side
	const [hotpCode, setHotpCode] = useState('');
	const [hotpBusy, setHotpBusy] = useState(false);
	// Edit-mode counter text while it is not a valid number
	const [hotpCounterDraft, setHotpCounterDraft] = useState<string | null>(null);

	// SSH key on this entry (see SshAgentService): the record in the
	// KeeAgent.settings attachment, what the main process can say about the
	// chosen key, and whether the agent currently holds it
	const [sshKeyInfo, setSshKeyInfo] = useState<SshKeyInspection | null>(null);
	const [sshLoaded, setSshLoaded] = useState<boolean | null>(null);
	const [sshBusy, setSshBusy] = useState(false);
	const [sshError, setSshError] = useState('');
	// Non-null while a multi-account Google Authenticator export awaits a pick
	const [migrationAccounts, setMigrationAccounts] = useState<MigrationAccount[] | null>(null);
	const [migrationSelected, setMigrationSelected] = useState(0);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [editedEntry, setEditedEntry] = useState<Entry>(() => {
		if (isNew) {
			return KeepassDatabaseService.createNewEntry();
		}
		return entry || KeepassDatabaseService.createNewEntry();
	});

	// The latest edit state, readable from the reset effect without putting
	// isEditing in its deps (which would re-run the reset on every edit-mode
	// toggle rather than only when the entry prop changes)
	const isEditingRef = useRef(isEditing);
	isEditingRef.current = isEditing;
	const prevEntryIdRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const sameEntry = !isNew && entry !== undefined && entry?.id === prevEntryIdRef.current;
		prevEntryIdRef.current = entry?.id;
		// Generating a HOTP code saves the advanced counter, and that save
		// refreshes this same entry: the code must survive that refresh and
		// only clear on a real selection change
		if (!sameEntry) {
			setHotpCode('');
			setHotpCounterDraft(null);
		}
		// The same entry arriving as a new object is a model refresh, not a
		// selection: history grew after our own save, or a background save
		// landed (a browser set-login). Mid-edit, that refresh must not
		// re-seed the form and throw away what the user has typed
		if (sameEntry && isEditingRef.current) return;

		// A reveal belongs to the entry it was clicked on: switching entries
		// must not carry it over and render the next password in plaintext
		setShowPassword(false);
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
				// No password (passkey-only entries): no breach or strength
				// warnings, even if a stale cached status says otherwise
				const password = KeepassDatabaseService.getPasswordString(entry.password);
				if (!password) {
					setBreachStatus(null);
					setPasswordStrength(null);
				} else {
					const status = BreachCheckService.getEntryBreachStatus(databasePath, entry.id);
					setBreachStatus(status);

					// Check password strength locally (no network call)
					setPasswordStrength(HaveIBeenPwnedService.checkPasswordStrength(password));
				}
			}
		} else if (isNew) {
			setEditedEntry(KeepassDatabaseService.createNewEntry());
			setIsEditing(true);
			setBreachStatus(null);
			setPasswordStrength(null);
		}
	}, [entry, isNew]);

	// Entry shortcuts, window-wide so they work wherever focus is (the search
	// box usually holds it). The handlers change with every render, so the
	// listener reads the latest through a ref
	const shortcutActions = useRef<Record<string, () => void>>({});
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// A generator, wizard or picker on top owns the keyboard
			if (dialogOpen()) return;
			const chords = isEditing || isNew
				? { 'Mod+Enter': 'save' }
				: { 'Mod+C': 'copyPassword', 'Mod+B': 'copyUsername', 'Mod+T': 'copyOtp', 'Mod+U': 'openUrl', 'Mod+E': 'edit' };
			for (const [chord, action] of Object.entries(chords)) {
				if (!matchesChord(e, chord)) continue;
				e.preventDefault();
				shortcutActions.current[action]?.();
				return;
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [isEditing, isNew]);

	// This panel is not remounted when the selection changes, so the entry has
	// to be part of what identifies a copy button. Without it the countdown
	// badge would follow the user onto the next entry's field of the same name
	const copySource = (field: string) => `entry:${editedEntry.id}:${field}`;

	// View mode and copies hand out resolved values ({REF:...}, {USERNAME},
	// ...); the edit form works on the raw text so references stay editable
	const resolved = (text: string): string =>
		PlaceholderService.displayField(text, editedEntry);

	// The one rule for field values in the JSX: raw while editing, resolved
	// in view mode
	const display = (text: string): string => isEditing ? text : resolved(text);

	const applyReferenceToken = (token: string) => {
		switch (refWizardField) {
			case 'T': setEditedEntry({ ...editedEntry, title: token }); break;
			case 'U': setEditedEntry({ ...editedEntry, username: token }); break;
			case 'P': setEditedEntry({ ...editedEntry, password: token }); break;
			case 'A': setEditedEntry({ ...editedEntry, url: token }); break;
			// Notes hold prose; the reference joins it instead of replacing it
			case 'N': {
				const notes = editedEntry.notes ?? '';
				setEditedEntry({ ...editedEntry, notes: notes ? `${notes}\n${token}` : token });
				break;
			}
		}
	};

	const cancelMigration = () => {
		setMigrationAccounts(null);
		setMigrationSelected(0);
	};

	const renderReferenceButton = (code: ReferenceFieldCode) => (
		<button
			className="generate-button"
			onClick={() => setRefWizardField(code)}
			title="Insert a reference to another entry's field" aria-label="Insert a reference to another entry's field"
			type="button"
		>
			<LinkActionIcon />
		</button>
	);

	const copyToClipboard = (text: string, field: string) =>
		ClipboardService.copy(resolved(text), field, copySource(field));

	const renderCopyButton = (onClick: () => void, title: string, field: string) => (
		<>
			<button
				className="copy-button"
				onClick={onClick}
				title={title} aria-label={title}
			>
				<CopyActionIcon />
				{clipboard.secondsLeft > 0 && clipboard.source === copySource(field) && (
					<div className="clipboard-timer" style={{ '--progress': `${(clipboard.secondsLeft / clipboard.totalSeconds) * 100}%` } as React.CSSProperties}>
						{clipboard.secondsLeft}s
					</div>
				)}
			</button>
		</>
	);

	const handleSave = () => {
		if (!editedEntry.title.trim()) return;
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

	const sshSettings = useMemo(() => SshAgentService.readSettings(editedEntry), [editedEntry.attachments]);
	const sshCandidates = useMemo(() => SshAgentService.keyCandidates(editedEntry), [editedEntry.attachments]);
	const sshAttachment = useMemo(() => SshAgentService.keyAttachment(editedEntry, sshSettings), [editedEntry.attachments, sshSettings]);
	const sshFingerprint = sshKeyInfo?.success ? sshKeyInfo.fingerprint : '';

	// Type and fingerprint of the chosen key. While editing, the password
	// field changes with every keystroke, so the passphrase is only tried
	// against a saved entry; the clear part of an OpenSSH file still names
	// the key without it
	useEffect(() => {
		if (!sshAttachment || !window.electron?.sshAgentInspectKey) {
			setSshKeyInfo(null);
			return;
		}
		let cancelled = false;
		window.electron.sshAgentInspectKey(
			KeepassDatabaseService.getAttachmentBytes(sshAttachment),
			isEditing ? undefined : SshAgentService.passphraseOf(editedEntry)
		).then(info => { if (!cancelled) setSshKeyInfo(info); })
			.catch(() => { if (!cancelled) setSshKeyInfo(null); });
		return () => { cancelled = true; };
	}, [sshAttachment, isEditing, editedEntry.password]);

	const refreshSshLoaded = async (fingerprint: string) => {
		if (!window.electron?.sshAgentStatus) return;
		try {
			const status = await window.electron.sshAgentStatus();
			setSshLoaded(status.running && status.identities.some(identity => identity.fingerprint === fingerprint));
		} catch {
			setSshLoaded(null);
		}
	};

	useEffect(() => {
		if (isEditing || !sshFingerprint) {
			setSshLoaded(null);
			return;
		}
		refreshSshLoaded(sshFingerprint);
	}, [sshFingerprint, isEditing]);

	const updateSshSettings = (patch: Partial<KeeAgentSettings> | null) => {
		setEditedEntry(prev => {
			const current = SshAgentService.readSettings(prev);
			const next = patch === null ? null : { ...(current ?? ENABLED_KEEAGENT_SETTINGS(patch.attachmentName ?? '')), ...patch };
			return { ...prev, attachments: SshAgentService.attachmentsWithSettings(prev.attachments, next) };
		});
	};

	const handleSshChooseKey = (name: string) => {
		setSshError('');
		if (!name) {
			updateSshSettings(null);
			return;
		}
		updateSshSettings({ ...ENABLED_KEEAGENT_SETTINGS(name), ...(sshSettings?.selectedType === 'attachment' ? {
			addAtDatabaseOpen: sshSettings.addAtDatabaseOpen,
			removeAtDatabaseClose: sshSettings.removeAtDatabaseClose,
			useConfirmConstraintWhenAdding: sshSettings.useConfirmConstraintWhenAdding,
			useLifetimeConstraintWhenAdding: sshSettings.useLifetimeConstraintWhenAdding,
			lifetimeConstraintDuration: sshSettings.lifetimeConstraintDuration,
		} : {}), attachmentName: name });
	};

	const handleSshToggleAgent = async () => {
		if (sshBusy) return;
		setSshBusy(true);
		setSshError('');
		try {
			const result = sshLoaded
				? await SshAgentService.removeEntryKey(editedEntry, sshSettings)
				: await SshAgentService.addEntryKey(editedEntry, sshSettings);
			if (!result.success) setSshError(result.error ?? 'Failed');
			if (sshFingerprint) await refreshSshLoaded(sshFingerprint);
		} finally {
			setSshBusy(false);
		}
	};

	const sshKeyDescription = (): string => {
		if (!sshKeyInfo) return '';
		if (!sshKeyInfo.success) return sshKeyInfo.error;
		const name = sshKeyInfo.type && sshKeyInfo.fingerprint ? `${sshKeyInfo.type} ${sshKeyInfo.fingerprint}` : '';
		if (!sshKeyInfo.passphraseError) return name;
		// While editing the passphrase is not tried, so this only says the key
		// has one; in view mode the entry password was tried and did not fit
		if (isEditing) return name ? `${name}, opened with the entry password` : 'Passphrase-protected key, opened with the entry password';
		const why = /needs a passphrase/i.test(sshKeyInfo.passphraseError)
			? 'the entry password is empty and this key needs one'
			: 'the entry password does not open this key';
		return name ? `${name}, ${why}` : `Passphrase-protected key, ${why}`;
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

	// Committed on Enter, comma or blur. normalizeTags drops the delimiters kdbx
	// would otherwise split the tag on, plus duplicates and blanks
	const handleAddTag = (raw: string) => {
		const addition = KeepassDatabaseService.normalizeTags(raw.split(','));
		if (addition.length === 0) {
			setTagDraft('');
			return;
		}
		setEditedEntry(prev => ({
			...prev,
			tags: KeepassDatabaseService.normalizeTags([...(prev.tags ?? []), ...addition]),
		}));
		setTagDraft('');
	};

	const handleRemoveTag = (tag: string) => {
		setEditedEntry(prev => ({
			...prev,
			tags: (prev.tags ?? []).filter(t => t !== tag),
		}));
	};

	const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			handleAddTag(tagDraft);
			return;
		}
		// Backspace on an empty box removes the last chip, as tag inputs do
		if (e.key === 'Backspace' && !tagDraft && (editedEntry.tags ?? []).length > 0) {
			handleRemoveTag(editedEntry.tags[editedEntry.tags.length - 1]);
		}
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

	const otpConfig = useMemo(
		() => TotpService.getConfig(editedEntry.customFields),
		[editedEntry.customFields]
	);
	const totpConfig = otpConfig?.type === 'totp' ? otpConfig : null;
	const hotpConfig = otpConfig?.type === 'hotp' ? otpConfig : null;

	const passkeyInfo = useMemo(
		() => PasskeyService.passkeyFromFields(editedEntry.customFields),
		[editedEntry.customFields]
	);

	// OTP and passkey fields get dedicated UI; keep them out of the generic
	// custom field list but preserve original indices for the handlers. OTP
	// keys stay listed when they did not parse, so an unreadable otp value
	// is visible and can be repaired rather than silently hidden
	const visibleCustomFields = useMemo(
		() => editedEntry.customFields
			.map((field, index) => ({ field, index }))
			.filter(({ field }) => !(otpConfig && TotpService.isTotpKey(field.key))
				&& !(passkeyInfo && PasskeyService.isPasskeyFieldKey(field.key))),
		[editedEntry.customFields, otpConfig, passkeyInfo]
	);

	const handleRemovePasskey = () => {
		if (!window.confirm('Remove the passkey from this entry? Remove it from the website\'s account settings too.')) return;
		const cleaned = {
			...editedEntry,
			customFields: editedEntry.customFields.filter(f => !PasskeyService.isPasskeyFieldKey(f.key)),
		};
		setEditedEntry(cleaned);
		onSave(KeepassDatabaseService.prepareEntryForSave(cleaned));
	};

	// One click: the code is shown and copied, and the counter it consumed
	// is advanced and saved right away (the same view-mode write path as
	// removing a passkey). If the browser extension advanced the counter
	// out-of-model moments ago, this click may reuse it: the kdbx keeps the
	// higher value (registerUnmodeledEdits), the user gets one rejected code
	const handleGenerateHotp = async () => {
		if (!hotpConfig || hotpBusy) return;
		setHotpBusy(true);
		try {
			const code = await TotpService.generateCode(hotpConfig);
			setHotpCode(code);
			copyToClipboard(code, 'One-time code');
			const advanced = {
				...editedEntry,
				customFields: TotpService.withCounter(editedEntry.customFields, hotpConfig.counter + 1),
			};
			setEditedEntry(advanced);
			onSave(KeepassDatabaseService.prepareEntryForSave(advanced));
		} catch {
			setHotpCode('');
		} finally {
			setHotpBusy(false);
		}
	};

	// Resync with the service: the next counter value, saved with the form
	const handleHotpCounterChange = (raw: string) => {
		setHotpCounterDraft(raw);
		const counter = parseInt(raw, 10);
		if (!Number.isSafeInteger(counter) || counter < 0 || String(counter) !== raw.trim()) return;
		setEditedEntry(prev => ({ ...prev, customFields: TotpService.withCounter(prev.customFields, counter) }));
		setHotpCounterDraft(null);
	};

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

	const applyTotpConfig = (config: OtpConfig) => {
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

	const applyTotpText = (text: string, invalidMessage: string): boolean => {
		const config = TotpService.parseUserInput(text);
		if (!config) {
			setTotpError(invalidMessage);
			return false;
		}
		applyTotpConfig(config);
		return true;
	};

	const handleAddTotp = () => {
		applyTotpText(totpInput, 'Enter a base32 secret or an otpauth:// URI');
	};

	const handleQrResult = (result: { text?: string; error?: string }) => {
		if (!result.text) {
			setTotpError(result.error ?? 'No QR code found');
			return;
		}
		if (result.text.startsWith('otpauth-migration://')) {
			const accounts = TotpService.parseMigrationUri(result.text);
			if (!accounts || accounts.length === 0) {
				setTotpError('Could not read the Google Authenticator export QR');
				return;
			}
			if (accounts.length === 1) {
				applyTotpConfig(accounts[0].config);
				return;
			}
			// Several accounts in the export: let the user pick the one that
			// belongs to this entry
			setMigrationAccounts(accounts);
			return;
		}
		applyTotpText(result.text, 'The QR code holds no TOTP secret');
	};

	const handleScanScreen = async () => {
		setTotpError('');
		handleQrResult(await QrScanService.scanScreens());
	};

	const handleScanClipboard = async () => {
		setTotpError('');
		handleQrResult(await QrScanService.scanClipboard());
	};

	const handleScanImageFile = () => {
		setTotpError('');
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/*';
		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (file) handleQrResult(await QrScanService.scanFile(file));
		};
		input.click();
	};

	const handleRemoveTotp = () => {
		setEditedEntry(prev => ({
			...prev,
			customFields: prev.customFields.filter(f => !TotpService.isTotpKey(f.key)),
		}));
		setHotpCode('');
	};

	const handleRestoreVersion = (version: EntryVersion) => {
		const restored: Entry = {
			...editedEntry,
			title: version.title,
			username: version.username,
			password: version.password,
			url: version.url,
			notes: version.notes,
			// Restoring a revision restores how its fields were protected too
			protectedFields: version.protectedFields,
			attachments: version.attachments,
			expires: version.expires,
			expiryTime: version.expiryTime,
			customFields: version.customFields,
			tags: version.tags ?? [],
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

		setPasswordStrength(newPassword ? HaveIBeenPwnedService.checkPasswordStrength(newPassword) : null);
	};

	const openUrl = async () => {
		if (!editedEntry.url) return;
		// Non-web schemes are refused in the main process; say so rather
		// than leaving the button looking broken
		const result = await window.electron?.openExternal(resolved(editedEntry.url));
		if (result && !result.success) {
			(window as any).showToast?.({
				message: result.error ?? 'Failed to open the link',
				type: 'error'
			});
		}
	};

	shortcutActions.current = {
		save: handleSave,
		copyPassword: () => copyToClipboard(KeepassDatabaseService.getPasswordString(editedEntry.password), 'Password'),
		copyUsername: () => copyToClipboard(editedEntry.username, 'Username'),
		// TOTP shows a code; HOTP has to generate one, which also copies it
		copyOtp: () => {
			if (totpCode) copyToClipboard(totpCode, 'One-time code');
			else if (hotpConfig) handleGenerateHotp();
		},
		openUrl,
		edit: () => setIsEditing(true),
	};

	const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Escape' || e.defaultPrevented || isEditing || !onReturnFocus) return;
		if (isEditableTarget(e.target)) return;
		e.preventDefault();
		onReturnFocus();
	};

	return (
		<div className="entry-details" ref={panelRef} tabIndex={-1} onKeyDown={handlePanelKeyDown}>
			<div className="entry-details-header">
				<h2>{isNew ? 'New Entry' : editedEntry.title}</h2>
				<div className="entry-details-actions">
					{!isNew && !isEditing && (
						<button
							className="edit-button"
							onClick={() => setIsEditing(true)}
							title="Edit entry" aria-label="Edit entry"
						>
							<EditActionIcon />
						</button>
					)}
					<button className="entry-close-button" onClick={handleClose} aria-label="Close entry">
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
						<p>This email address has appeared in a data breach since the password was last changed. Consider using a different email address or monitoring for suspicious activity.</p>
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
						<p>{passwordStrength.feedback.warning || 'Use a stronger password.'}</p>
					</div>
				</div>
			)}

			<div className="entry-fields">
				<div className="field-group">
					<label htmlFor="entry-title">Title</label>
					<div className="field-value-container">
						<input
							id="entry-title"
							type="text"
							value={display(editedEntry.title)}
							onChange={(e) => setEditedEntry({ ...editedEntry, title: e.target.value })}
							className="field-value"
							readOnly={!isEditing}
							placeholder="Enter title"
						/>
						{isEditing && renderReferenceButton('T')}
						{!isEditing && editedEntry.title && renderCopyButton(
							() => copyToClipboard(editedEntry.title, 'Title'),
							'Copy title',
							'Title'
						)}
					</div>
				</div>

				{isEditing && (
					<div className="field-group">
						<label>Icon</label>
						<div className="entry-icon-row">
							<ItemIcon
								icon={editedEntry.icon}
								customIcon={editedEntry.customIcon}
								className="entry-icon-preview"
								fallback={<KeePassIcon index={0} className="entry-icon-preview" />}
							/>
							<button
								className="icon-picker-file-button"
								onClick={() => setShowIconPicker(v => !v)}
								type="button"
							>
								{showIconPicker ? 'Hide icons' : 'Change...'}
							</button>
							{!showIconPicker && (editedEntry.customIcon !== undefined || !!editedEntry.icon) && (
								<button
									className="icon-picker-file-button"
									onClick={() => applyIconChange(undefined, undefined)}
									title="Back to the default key icon"
									type="button"
								>
									Remove icon
								</button>
							)}
							{editedEntry.customIcon === undefined && !editedEntry.icon && editedEntry.suppressFavicon && editedEntry.url && (
								<button
									className="icon-picker-file-button"
									onClick={() => {
										FaviconService.forget(editedEntry.url!);
										setEditedEntry({ ...editedEntry, suppressFavicon: undefined });
									}}
									title="Fetch and store this site's favicon again"
									type="button"
								>
									Use website favicon
								</button>
							)}
						</div>
						{showIconPicker && (
							<IconPicker
								defaultIndex={0}
								icon={editedEntry.icon}
								customIcon={editedEntry.customIcon}
								onChange={applyIconChange}
							/>
						)}
					</div>
				)}

				<div className="field-group">
					<label htmlFor="entry-username">Username</label>
					<div className="field-value-container">
						<input
							id="entry-username"
							type="text"
							value={display(editedEntry.username)}
							onChange={(e) => setEditedEntry({ ...editedEntry, username: e.target.value })}
							className="field-value monospace"
							readOnly={!isEditing}
							placeholder="Enter username"
						/>
						{isEditing && renderReferenceButton('U')}
						{!isEditing && editedEntry.username && renderCopyButton(
							() => copyToClipboard(editedEntry.username, 'Username'),
							'Copy username',
							'Username'
						)}
					</div>
				</div>

				<div className="field-group">
					<label htmlFor="entry-password">Password</label>
					<div className="field-value-container">
						<input
							id="entry-password"
							type={showPassword ? 'text' : 'password'}
							value={display(KeepassDatabaseService.getPasswordString(editedEntry.password))}
							onChange={handlePasswordChange}
							className="field-value monospace"
							readOnly={!isEditing}
							placeholder="Enter password"
						/>
						<button
							className="visibility-button"
							onClick={() => setShowPassword(!showPassword)}
							title={showPassword ? 'Hide password' : 'Show password'} aria-label={showPassword ? 'Hide password' : 'Show password'}
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
								title="Generate password" aria-label="Generate password"
								type="button"
							>
								<GenerateActionIcon />
							</button>
						)}
						{isEditing && renderReferenceButton('P')}
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

				{!isEditing && hotpConfig && (
					<div className="field-group">
						<label>One-Time Code</label>
						<div className="field-value-container">
							<div className="totp-display">
								{hotpCode ? (
									<span className="totp-code">
										{hotpCode.slice(0, Math.ceil(hotpCode.length / 2))}&thinsp;{hotpCode.slice(Math.ceil(hotpCode.length / 2))}
									</span>
								) : (
									<span className="hotp-placeholder">Counter-based, generated on demand</span>
								)}
								<span className="totp-countdown" title="Next counter value">
									#{hotpConfig.counter}
								</span>
							</div>
							<button
								className="generate-button"
								onClick={handleGenerateHotp}
								disabled={hotpBusy}
								title="Generate the next code, copy it and advance the counter" aria-label="Generate the next code, copy it and advance the counter"
								type="button"
							>
								<GenerateActionIcon />
							</button>
							{hotpCode && renderCopyButton(
								() => copyToClipboard(hotpCode, 'One-time code'),
								'Copy one-time code',
								'One-time code'
							)}
						</div>
					</div>
				)}

				{isEditing && (
					<div className="field-group">
						<label>One-Time Password</label>
						{otpConfig ? (
							<div className="totp-configured-row">
								{otpConfig.type === 'totp' ? (
									<span className="totp-configured-text">
										TOTP configured ({otpConfig.digits} digits, {otpConfig.period}s, {otpConfig.algorithm})
									</span>
								) : (
									<span className="totp-configured-text hotp-configured">
										HOTP configured ({otpConfig.digits} digits, {otpConfig.algorithm}, counter
										<input
											type="number"
											className="hotp-counter-input"
											min={0}
											step={1}
											value={hotpCounterDraft ?? String(otpConfig.counter)}
											onChange={(e) => handleHotpCounterChange(e.target.value)}
											onBlur={() => setHotpCounterDraft(null)}
											title="Next counter value. Change it to resync with the service"
										/>
										)
									</span>
								)}
								<button
									className="field-remove-button"
									onClick={handleRemoveTotp}
									title="Remove one-time password" aria-label="Remove one-time password"
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
									{window.electron && (
										<>
											<button className="totp-qr-button" onClick={handleScanScreen} type="button" title="Scan a QR code shown on your screen (the window hides itself while scanning)" aria-label="Scan a QR code shown on your screen (the window hides itself while scanning)">
												<MonitorActionIcon />
											</button>
											<button className="totp-qr-button" onClick={handleScanClipboard} type="button" title="Read a QR code from a screenshot in the clipboard" aria-label="Read a QR code from a screenshot in the clipboard">
												<ClipboardActionIcon />
											</button>
										</>
									)}
									<button className="totp-qr-button" onClick={handleScanImageFile} type="button" title="Read a QR code from an image file" aria-label="Read a QR code from an image file">
										<ImageActionIcon />
									</button>
								</div>
								{totpError && <div className="totp-error">{totpError}</div>}
							</>
						)}
					</div>
				)}

				<div className="field-group">
					<label htmlFor="entry-url">URL</label>
					<div className="field-value-container">
						<input
							id="entry-url"
							type="text"
							value={display(editedEntry.url ?? '')}
							onChange={(e) => setEditedEntry({ ...editedEntry, url: e.target.value })}
							className="field-value"
							readOnly={!isEditing}
							placeholder="Enter URL"
						/>
						{isEditing && renderReferenceButton('A')}
						{!isEditing && editedEntry.url && (
							<>
								{renderCopyButton(
									() => copyToClipboard(editedEntry.url!, 'URL'),
									'Copy URL',
									'URL'
								)}
								<button
									onClick={openUrl}
									className="open-button"
									title="Open URL" aria-label="Open URL"
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
									aria-label="Expiry date"
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

				{!isEditing && passkeyInfo && (
					<div className="field-group">
						<label>Passkey</label>
						<div className="passkey-panel">
							<PasskeyActionIcon className="passkey-panel-icon" />
							<div className="passkey-panel-info">
								<span className="passkey-panel-rp">{passkeyInfo.relyingParty}</span>
								{passkeyInfo.username && <span className="passkey-panel-user">{passkeyInfo.username}</span>}
							</div>
							<button className="passkey-remove-button" onClick={handleRemovePasskey}>
								Remove
							</button>
						</div>
					</div>
				)}

				<div className="field-group">
					<label htmlFor="entry-notes">Notes</label>
					<div className="field-value-container notes-container">
						<textarea
							id="entry-notes"
							value={display(editedEntry.notes ?? '')}
							onChange={(e) => setEditedEntry({ ...editedEntry, notes: e.target.value })}
							className="field-value notes"
							readOnly={!isEditing}
							placeholder="Enter notes"
						/>
						{isEditing && renderReferenceButton('N')}
					</div>
				</div>

				{(isEditing || (editedEntry.tags ?? []).length > 0) && (
					<div className="field-group">
						<label htmlFor="entry-tags">Tags</label>
						<div className={`tag-list ${isEditing ? 'editing' : ''}`}>
							{(editedEntry.tags ?? []).map(tag => (
								isEditing ? (
									<span className="tag-chip" key={tag}>
										{tag}
										<button
											className="tag-chip-remove"
											onClick={() => handleRemoveTag(tag)}
											title={`Remove ${tag}`} aria-label={`Remove ${tag}`}
											type="button"
										>
											<CloseActionIcon />
										</button>
									</span>
								) : (
									<button
										className="tag-chip clickable"
										key={tag}
										onClick={() => onTagClick?.(tag)}
										title={`Show everything tagged ${tag}`} aria-label={`Show everything tagged ${tag}`}
										type="button"
									>
										{tag}
									</button>
								)
							))}
							{isEditing && (
								<>
									<input
										type="text"
										id="entry-tags"
										className="tag-input"
										value={tagDraft}
										list="vigil-tag-suggestions"
										placeholder={(editedEntry.tags ?? []).length ? 'Add tag' : 'Add tag, Enter to confirm'}
										onChange={(e) => {
											// A comma is a separator rather than a character, so
											// pasting "a, b, c" commits all three at once
											if (e.target.value.includes(',')) handleAddTag(e.target.value);
											else setTagDraft(e.target.value);
										}}
										onKeyDown={handleTagKeyDown}
										onBlur={() => handleAddTag(tagDraft)}
									/>
									<datalist id="vigil-tag-suggestions">
										{allTags
											.filter(tag => !(editedEntry.tags ?? []).some(t => t.toLowerCase() === tag.toLowerCase()))
											.map(tag => <option value={tag} key={tag} />)}
									</datalist>
								</>
							)}
						</div>
					</div>
				)}

				{!isEditing && visibleCustomFields.map(({ field, index }) => (
					<div className="field-group" key={index}>
						<label htmlFor={`entry-custom-${index}`}>{field.key}</label>
						<div className="field-value-container">
							<input
								id={`entry-custom-${index}`}
								type={field.protected && !revealedCustomFields.has(index) ? 'password' : 'text'}
								value={resolved(KeepassDatabaseService.getFieldString(field.value))}
								className={`field-value ${field.protected ? 'monospace' : ''}`}
								readOnly
							/>
							{field.protected && (
								<button
									className="visibility-button"
									onClick={() => toggleCustomFieldReveal(index)}
									title={revealedCustomFields.has(index) ? 'Hide value' : 'Show value'} aria-label={revealedCustomFields.has(index) ? 'Hide value' : 'Show value'}
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
										aria-label="Field name"
										onChange={(e) => handleCustomFieldChange(index, { key: e.target.value })}
									/>
									<input
										type="text"
										className="field-value custom-field-value"
										value={KeepassDatabaseService.getFieldString(field.value)}
										placeholder="Value"
										aria-label="Field value"
										onChange={(e) => handleCustomFieldChange(index, { value: e.target.value })}
									/>
									<button
										className={`custom-field-protect ${field.protected ? 'active' : ''}`}
										onClick={() => handleCustomFieldChange(index, { protected: !field.protected })}
										title={field.protected ? 'Value is protected (stored encrypted, shown masked)' : 'Protect value'} aria-label={field.protected ? 'Value is protected (stored encrypted, shown masked)' : 'Protect value'}
										type="button"
									>
										<SecurityShieldIcon />
									</button>
									<button
										className="field-remove-button"
										onClick={() => handleRemoveCustomField(index)}
										title="Remove field" aria-label="Remove field"
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

				{!isEditing && sshSettings?.allowUseOfSshKey && (
					<div className="field-group">
						<label>SSH Key</label>
						{sshSettings.selectedType !== 'attachment' ? (
							<div className="ssh-key-row">
								<span className="ssh-key-text">
									Key file outside the vault{sshSettings.fileName ? ` (${sshSettings.fileName})` : ''}. Vigil loads keys from attachments only
								</span>
							</div>
						) : (
							<div className="ssh-key-row">
								<span className="ssh-key-text" title={sshFingerprint || undefined}>
									{sshAttachment ? sshKeyDescription() || sshAttachment.name : `Attachment ${sshSettings.attachmentName} is missing`}
								</span>
								{sshAttachment && sshLoaded !== null && (
									<span className={`ssh-key-state ${sshLoaded ? 'loaded' : ''}`}>{sshLoaded ? 'in agent' : 'not in agent'}</span>
								)}
								{sshAttachment && (
									<button
										className="totp-add-button"
										onClick={handleSshToggleAgent}
										disabled={sshBusy || !window.electron}
										type="button"
									>
										{sshLoaded ? 'Remove from agent' : 'Add to agent'}
									</button>
								)}
							</div>
						)}
						{sshError && <div className="totp-error">{sshError}</div>}
					</div>
				)}

				{isEditing && (sshCandidates.length > 0 || sshSettings) && (
					<div className="field-group">
						<label>SSH Agent</label>
						<div className="ssh-key-config">
							{sshSettings?.selectedType === 'file' && sshSettings.allowUseOfSshKey ? (
								<div className="ssh-key-row">
									<span className="ssh-key-text">
										Key file outside the vault{sshSettings.fileName ? ` (${sshSettings.fileName})` : ''}. Vigil loads keys from attachments only and leaves this as is
									</span>
									<button className="field-remove-button" onClick={() => updateSshSettings(null)} title="Forget this key" aria-label="Forget this key" type="button">
										<CloseActionIcon />
									</button>
								</div>
							) : (
								<select
									className="field-value ssh-key-select"
									value={sshSettings?.selectedType === 'attachment' ? sshSettings.attachmentName : ''}
									onChange={(e) => handleSshChooseKey(e.target.value)}
								>
									<option value="">No SSH key</option>
									{sshCandidates.map(candidate => (
										<option key={candidate.name} value={candidate.name}>{candidate.name}</option>
									))}
									{sshSettings?.selectedType === 'attachment' && sshSettings.attachmentName && !sshCandidates.some(c => c.name === sshSettings.attachmentName) && (
										<option value={sshSettings.attachmentName}>{sshSettings.attachmentName} (missing)</option>
									)}
								</select>
							)}
							{sshSettings?.selectedType === 'attachment' && sshSettings.allowUseOfSshKey && (
								<>
									<label className="ssh-option">
										<input type="checkbox" checked={sshSettings.addAtDatabaseOpen} onChange={(e) => updateSshSettings({ addAtDatabaseOpen: e.target.checked })} />
										Add to the agent when the vault opens
									</label>
									<label className="ssh-option">
										<input type="checkbox" checked={sshSettings.removeAtDatabaseClose} onChange={(e) => updateSshSettings({ removeAtDatabaseClose: e.target.checked })} />
										Remove from the agent when the vault locks
									</label>
									<label className="ssh-option">
										<input type="checkbox" checked={sshSettings.useConfirmConstraintWhenAdding} onChange={(e) => updateSshSettings({ useConfirmConstraintWhenAdding: e.target.checked })} />
										Ask for confirmation on every use
									</label>
									<label className="ssh-option">
										<input type="checkbox" checked={sshSettings.useLifetimeConstraintWhenAdding} onChange={(e) => updateSshSettings({ useLifetimeConstraintWhenAdding: e.target.checked })} />
										Forget the key after
										<input
											type="number"
											className="ssh-lifetime"
											min={1}
											value={sshSettings.lifetimeConstraintDuration}
											disabled={!sshSettings.useLifetimeConstraintWhenAdding}
											onChange={(e) => updateSshSettings({ lifetimeConstraintDuration: Math.max(1, parseInt(e.target.value, 10) || 1) })}
										/>
										seconds
									</label>
									<div className="ssh-key-hint">
										{sshKeyDescription() || 'The entry password is used as the key passphrase'}
									</div>
								</>
							)}
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
											title="Save file" aria-label="Save file"
										>
											<DownloadActionIcon />
										</button>
									) : (
										<button
											className="attachment-action-button remove"
											onClick={() => handleRemoveAttachment(attachment.name)}
											title="Remove file" aria-label="Remove file"
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
													title={showVersionPassword ? 'Hide password' : 'Show password'} aria-label={showVersionPassword ? 'Hide password' : 'Show password'}
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
											{(version.tags ?? []).length > 0 && (
												<div className="history-field">
													<span className="history-field-label">Tags</span>
													<span className="history-field-value">{version.tags.join(', ')}</span>
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

				{migrationAccounts && (
					<Modal overlayClassName="pairing-overlay" className="pairing-dialog" labelledBy="migration-title" onClose={cancelMigration}>
							<h3 id="migration-title">Choose an account</h3>
							<p>The Google Authenticator export holds {migrationAccounts.length} accounts. Pick the one for this entry.</p>
							<div className="passkey-entry-list">
								{migrationAccounts.map((account, i) => (
									<label key={i} className="passkey-entry-row">
										<input
											type="radio"
											name="migration-account"
											checked={migrationSelected === i}
											onChange={() => setMigrationSelected(i)}
										/>
										<span className="passkey-entry-title">{account.issuer || account.name || 'Unnamed account'}</span>
										{account.issuer && account.name && <span className="passkey-entry-username">{account.name}</span>}
									</label>
								))}
							</div>
							<div className="pairing-actions">
								<button
									className="pairing-cancel-button"
									onClick={cancelMigration}
								>
									Cancel
								</button>
								<button
									className="pairing-allow-button"
									onClick={() => {
										applyTotpConfig(migrationAccounts[migrationSelected].config);
										setMigrationAccounts(null);
										setMigrationSelected(0);
									}}
								>
									Use this account
								</button>
							</div>
					</Modal>
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
				{refWizardField && (
					<ReferenceWizard
						defaultField={refWizardField}
						excludeEntryId={editedEntry.id || undefined}
						onInsert={applyReferenceToken}
						onClose={() => setRefWizardField(null)}
					/>
				)}
			</div>
		</div>
	);
};
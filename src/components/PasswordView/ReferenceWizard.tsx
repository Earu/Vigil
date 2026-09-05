import { useMemo, useState } from 'react';
import { Entry } from '../../types/database';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { PlaceholderService, uuidBase64ToHex } from '../../services/PlaceholderService';
import { CloseActionIcon } from '../../icons/actions/ActionIcons';
import { ItemIcon } from './ItemIcon';
import { Modal } from '../Modal';
import './ReferenceWizard.css';

// Builds a {REF:...} token without making the user learn the syntax: pick
// the entry, pick which of its fields to pull, insert. References are
// written by UUID, so renaming the target never breaks them.

export type ReferenceFieldCode = 'T' | 'U' | 'P' | 'A' | 'N';

const FIELD_CHOICES: Array<{ code: ReferenceFieldCode; label: string }> = [
	{ code: 'T', label: 'Title' },
	{ code: 'U', label: 'Username' },
	{ code: 'P', label: 'Password' },
	{ code: 'A', label: 'URL' },
	{ code: 'N', label: 'Notes' },
];

const MAX_LISTED = 200;

interface ReferenceWizardProps {
	// Field the token is going into, which is also the natural source field
	defaultField: ReferenceFieldCode;
	// The entry being edited: referencing yourself resolves to nothing useful
	excludeEntryId?: string;
	onInsert: (token: string) => void;
	onClose: () => void;
}

export const ReferenceWizard = ({ defaultField, excludeEntryId, onInsert, onClose }: ReferenceWizardProps) => {
	const [query, setQuery] = useState('');
	const [field, setField] = useState<ReferenceFieldCode>(defaultField);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const entries = useMemo(() => {
		const root = PlaceholderService.getModelRoot();
		if (!root) return [] as Entry[];
		const all = KeepassDatabaseService.getAllEntriesFromGroup(root)
			.filter(entry => entry.id && entry.id !== excludeEntryId);
		return KeepassDatabaseService.sortEntriesByTitle(
			KeepassDatabaseService.filterEntries(all, query));
	}, [query, excludeEntryId]);

	const selected = entries.find(entry => entry.id === selectedId) ?? null;

	const handleInsert = () => {
		if (!selected) return;
		onInsert(`{REF:${field}@I:${uuidBase64ToHex(selected.id).toUpperCase()}}`);
		onClose();
	};

	return (
		<Modal overlayClassName="reference-wizard-overlay" className="reference-wizard" labelledBy="reference-wizard-title" onClose={onClose} closeOnOverlayClick>
				<div className="reference-wizard-header">
					<h2 id="reference-wizard-title">Insert Reference</h2>
					<button className="entry-close-button" onClick={onClose} aria-label="Close">
						<CloseActionIcon />
					</button>
				</div>

				<div className="reference-wizard-body">
					<input
						type="text"
						className="field-value"
						placeholder="Search entries"
						aria-label="Search entries"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						autoFocus
					/>
					<div className="reference-entry-list">
						{entries.slice(0, MAX_LISTED).map(entry => (
							<button
								key={entry.id}
								className={`reference-entry ${entry.id === selectedId ? 'selected' : ''}`}
								onClick={() => setSelectedId(entry.id)}
								onDoubleClick={() => { setSelectedId(entry.id); handleInsert(); }}
							>
								<ItemIcon icon={entry.icon} customIcon={entry.customIcon} className="reference-entry-icon" />
								<span className="reference-entry-title">{entry.title || '(untitled)'}</span>
								<span className="reference-entry-username">{entry.username}</span>
							</button>
						))}
						{entries.length === 0 && (
							<div className="reference-entry-empty">No matching entries</div>
						)}
						{entries.length > MAX_LISTED && (
							<div className="reference-entry-empty">
								{entries.length - MAX_LISTED} more; narrow the search
							</div>
						)}
					</div>
					<div className="reference-field-row">
						<label htmlFor="reference-field">Field</label>
						<select
							id="reference-field"
							className="field-value"
							value={field}
							onChange={(e) => setField(e.target.value as ReferenceFieldCode)}
						>
							{FIELD_CHOICES.map(({ code, label }) => (
								<option key={code} value={code}>{label}</option>
							))}
						</select>
					</div>
				</div>

				<div className="field-group actions">
					<button className="entry-cancel-button" onClick={onClose}>
						Cancel
					</button>
					<button className="entry-save-button" onClick={handleInsert} disabled={!selected}>
						Insert
					</button>
				</div>
		</Modal>
	);
};

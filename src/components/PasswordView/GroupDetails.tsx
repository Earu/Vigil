import { useEffect, useState } from 'react';
import { Group } from '../../types/database';
import { CloseActionIcon } from '../../icons/actions/ActionIcons';
import { IconPicker } from './IconPicker';

// Group editing panel, living in the same slot as EntryDetails: name and
// icon. Picking the folder default in the picker clears the icon.

const FOLDER_ICON = 48;

export interface GroupChanges {
	name: string;
	icon?: number;
	customIcon?: string;
}

interface GroupDetailsProps {
	group: Group;
	onClose: () => void;
	onSave: (group: Group, changes: GroupChanges) => void;
}

export const GroupDetails = ({ group, onClose, onSave }: GroupDetailsProps) => {
	const [name, setName] = useState(group.name);
	const [icon, setIcon] = useState<number | undefined>(group.icon);
	const [customIcon, setCustomIcon] = useState<string | undefined>(group.customIcon);
	// Untouched fields stay out of the save entirely, so a rename cannot
	// write this panel's open-time icon snapshot over a change that merged
	// in while it was open
	const [iconTouched, setIconTouched] = useState(false);

	// Re-seed when the panel is pointed at another group; not on every model
	// refresh, which would clobber edits in progress
	useEffect(() => {
		setName(group.name);
		setIcon(group.icon);
		setCustomIcon(group.customIcon);
		setIconTouched(false);
	}, [group.id]);

	const canSave = name.trim().length > 0;

	const handleSave = () => {
		if (!canSave) return;
		onSave(group, iconTouched
			? { name: name.trim(), icon, customIcon }
			: { name: name.trim() });
	};

	return (
		<div className="entry-details">
			<div className="entry-details-header">
				<h2>Edit Group</h2>
				<div className="entry-details-actions">
					<button className="entry-close-button" onClick={onClose}>
						<CloseActionIcon />
					</button>
				</div>
			</div>

			<div className="entry-fields">
				<div className="field-group">
					<label>Name</label>
					<div className="field-value-container">
						<input
							type="text"
							className="field-value"
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
							placeholder="Group name"
							autoFocus
						/>
					</div>
				</div>

				<div className="field-group">
					<label>Icon</label>
					<IconPicker
						defaultIndex={FOLDER_ICON}
						icon={icon}
						customIcon={customIcon}
						onChange={(nextIcon, nextCustomIcon) => {
							setIcon(nextIcon);
							setCustomIcon(nextCustomIcon);
							setIconTouched(true);
						}}
					/>
				</div>

				<div className="field-group actions">
					<button className="entry-cancel-button" onClick={onClose}>
						Cancel
					</button>
					<button className="entry-save-button" onClick={handleSave} disabled={!canSave}>
						Save
					</button>
				</div>
			</div>
		</div>
	);
};

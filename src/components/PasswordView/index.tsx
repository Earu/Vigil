import { useState, useEffect } from 'react';
import { Database, Entry, Group } from '../../types/database';
import { Sidebar } from './Sidebar';
import { EntryList } from './EntryList';
import { EntryDetails } from './EntryDetails';
import './PasswordView.css';

interface PasswordViewProps {
	database: Database;
	searchQuery: string;
	onDatabaseChange?: (database: Database) => void;
}

export const PasswordView = ({ database, searchQuery, onDatabaseChange }: PasswordViewProps) => {
	const [selectedGroup, setSelectedGroup] = useState<Group>(database.root);
	const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
	const [isCreatingNew, setIsCreatingNew] = useState(false);

	// Clear selected entry when changing groups or search query
	useEffect(() => {
		setSelectedEntry(null);
		setIsCreatingNew(false);
	}, [selectedGroup.id, searchQuery]);

	const handleGroupSelect = (group: Group) => {
		setSelectedGroup(group);
	};

	const handleSaveEntry = (entry: Entry) => {
		// Find the group containing the entry
		const findGroupContainingEntry = (group: Group): Group | null => {
			if (group.entries.some(e => e.id === entry.id)) {
				return group;
			}
			for (const subgroup of group.groups) {
				const found = findGroupContainingEntry(subgroup);
				if (found) return found;
			}
			return null;
		};

		const updatedDatabase = { ...database };

		if (isCreatingNew) {
			// Add the new entry to the current group
			selectedGroup.entries.push(entry);
			setIsCreatingNew(false);
		} else {
			// Find and update the existing entry
			const group = findGroupContainingEntry(database.root);
			if (group) {
				const entryIndex = group.entries.findIndex(e => e.id === entry.id);
				if (entryIndex !== -1) {
					group.entries[entryIndex] = entry;
				}
			}
		}

		setSelectedEntry(entry);
		onDatabaseChange?.(updatedDatabase);
	};

	const handleNewEntry = () => {
		setSelectedEntry(null);
		setIsCreatingNew(true);
	};

	const handleCloseEntry = () => {
		setSelectedEntry(null);
		setIsCreatingNew(false);
	};

	return (
		<div className="password-view">
			<div className="password-view-content">
				<Sidebar
					database={database}
					selectedGroup={selectedGroup}
					onGroupSelect={handleGroupSelect}
				/>
				<EntryList
					group={selectedGroup}
					searchQuery={searchQuery}
					selectedEntry={selectedEntry}
					onEntrySelect={setSelectedEntry}
					database={database}
					onNewEntry={handleNewEntry}
				/>
				{(selectedEntry || isCreatingNew) && (
					<EntryDetails
						entry={selectedEntry}
						onClose={handleCloseEntry}
						onSave={handleSaveEntry}
						isNew={isCreatingNew}
					/>
				)}
			</div>
		</div>
	);
};
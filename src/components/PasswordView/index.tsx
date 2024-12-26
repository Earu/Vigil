import { useState, useEffect } from 'react';
import { Database, Entry, Group } from '../../types/database';
import { Sidebar } from './Sidebar';
import { EntryList } from './EntryList';
import { EntryDetails } from './EntryDetails';
import './PasswordView.css';
import * as kdbxweb from 'kdbxweb';

// Deep copy helper that preserves Date objects and ProtectedValue objects
const deepCopyWithDates = (obj: any): any => {
	if (obj === null || typeof obj !== 'object') return obj;
	if (obj instanceof Date) return new Date(obj);
	if (obj instanceof kdbxweb.ProtectedValue) return obj;
	
	const copy: any = Array.isArray(obj) ? [] : {};
	for (const key in obj) {
		copy[key] = deepCopyWithDates(obj[key]);
	}
	return copy;
};

interface PasswordViewProps {
	database: Database;
	searchQuery: string;
	onDatabaseChange?: (database: Database) => void;
}

export const PasswordView = ({ database, searchQuery, onDatabaseChange }: PasswordViewProps) => {
	const [selectedGroup, setSelectedGroup] = useState<Group>(database.root);
	const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
	const [isCreatingNew, setIsCreatingNew] = useState(false);

	// Update selected group when database changes
	useEffect(() => {
		// Find the current group in the new database structure
		const findGroup = (group: Group): Group | null => {
			if (group.id === selectedGroup.id) {
				return group;
			}
			for (const subgroup of group.groups) {
				const found = findGroup(subgroup);
				if (found) return found;
			}
			return null;
		};

		const updatedGroup = findGroup(database.root);
		if (updatedGroup) {
			setSelectedGroup(updatedGroup);
		} else {
			// If group no longer exists, fall back to root
			setSelectedGroup(database.root);
		}
	}, [database]);

	// Clear selected entry when changing groups or search query
	useEffect(() => {
		setSelectedEntry(null);
		setIsCreatingNew(false);
	}, [selectedGroup.id, searchQuery]);

	const handleGroupSelect = (group: Group) => {
		// Find the group in the current database to ensure we have the latest version
		const findGroup = (searchGroup: Group): Group | null => {
			if (searchGroup.id === group.id) {
				return searchGroup;
			}
			for (const subgroup of searchGroup.groups) {
				const found = findGroup(subgroup);
				if (found) return found;
			}
			return null;
		};

		const currentGroup = findGroup(database.root);
		setSelectedGroup(currentGroup || database.root);
	};

	const handleGroupNameChange = (group: Group, newName: string) => {
		const updatedDatabase: Database = deepCopyWithDates(database);
		const updateGroupName = (searchGroup: Group): boolean => {
			if (searchGroup.id === group.id) {
				searchGroup.name = newName;
				return true;
			}
			for (const subgroup of searchGroup.groups) {
				if (updateGroupName(subgroup)) return true;
			}
			return false;
		};

		updateGroupName(updatedDatabase.root);
		onDatabaseChange?.(updatedDatabase);
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

		const updatedDatabase: Database = deepCopyWithDates(database);

		if (isCreatingNew) {
			// Add the new entry to the selected group instead of root
			const updatedGroup = findGroupInDatabase(selectedGroup.id, updatedDatabase.root) || updatedDatabase.root;
			updatedGroup.entries.push(entry);
			setIsCreatingNew(false);
		} else {
			// Find and update the existing entry
			const group = findGroupContainingEntry(updatedDatabase.root);
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
		setIsCreatingNew(true);
		setSelectedEntry(null);
	};

	const handleCloseEntry = () => {
		setSelectedEntry(null);
		setIsCreatingNew(false);
	};

	const handleNewGroup = (parentGroup: Group) => {
		const newGroup: Group = {
			id: '',
			name: "New Group",
			groups: [],
			entries: [],
			expanded: true,
		};

		const updatedDatabase: Database = deepCopyWithDates(database);
		const findAndUpdateGroup = (group: Group): boolean => {
			if (group.id === parentGroup.id) {
				group.groups.push(newGroup);
				return true;
			}
			for (const subgroup of group.groups) {
				if (findAndUpdateGroup(subgroup)) return true;
			}
			return false;
		};

		findAndUpdateGroup(updatedDatabase.root);
		onDatabaseChange?.(updatedDatabase);
	};

	const handleRemoveGroup = (groupToRemove: Group) => {
		if (groupToRemove.id === database.root.id) return; // Prevent removing root group

		const totalEntries = countEntriesInGroup(groupToRemove);
		const message = `Are you sure you want to remove the group "${groupToRemove.name}" and all its contents? This will delete ${totalEntries} entries and ${groupToRemove.groups.length} subgroups.`;

		if (!window.confirm(message)) return;

		const updatedDatabase: Database = deepCopyWithDates(database);

		// Remove from root's hierarchy if it exists there
		const removeGroupFromParent = (group: Group): boolean => {
			const index = group.groups.findIndex(g => g.id === groupToRemove.id);
			if (index !== -1) {
				group.groups.splice(index, 1);
				return true;
			}
			for (const subgroup of group.groups) {
				if (removeGroupFromParent(subgroup)) return true;
			}
			return false;
		};

		// First try to remove from root's hierarchy
		const removedFromRoot = removeGroupFromParent(updatedDatabase.root);

		// If not found in root's hierarchy, remove from top-level groups
		if (!removedFromRoot) {
			const topLevelIndex = updatedDatabase.groups.findIndex(g => g.id === groupToRemove.id);
			if (topLevelIndex !== -1) {
				updatedDatabase.groups.splice(topLevelIndex, 1);
			}
		}

		// Also clean up any potential duplicate references in top-level groups
		updatedDatabase.groups = updatedDatabase.groups.filter((g: Group) => g.id !== groupToRemove.id);

		if (selectedGroup.id === groupToRemove.id) {
			setSelectedGroup(updatedDatabase.root);
		}

		onDatabaseChange?.(updatedDatabase);
	};

	const handleMoveGroup = (groupToMove: Group, newParent: Group) => {
		const updatedDatabase: Database = deepCopyWithDates(database);

		// Helper function to find and remove the group from its current parent
		const removeFromCurrentParent = (searchGroup: Group): boolean => {
			const index = searchGroup.groups.findIndex(g => g.id === groupToMove.id);
			if (index !== -1) {
				searchGroup.groups.splice(index, 1);
				return true;
			}
			for (const subgroup of searchGroup.groups) {
				if (removeFromCurrentParent(subgroup)) return true;
			}
			return false;
		};

		// Helper function to find the new parent group
		const findNewParent = (searchGroup: Group): Group | null => {
			if (searchGroup.id === newParent.id) {
				return searchGroup;
			}
			for (const subgroup of searchGroup.groups) {
				const found = findNewParent(subgroup);
				if (found) return found;
			}
			return null;
		};

		// Remove the group from its current parent
		removeFromCurrentParent(updatedDatabase.root);

		// Find the new parent and add the group
		const targetParent = findNewParent(updatedDatabase.root);
		if (targetParent) {
			targetParent.groups.push(groupToMove);
		}

		onDatabaseChange?.(updatedDatabase);
	};

	const handleRemoveEntry = (entryToRemove: Entry) => {
		if (!window.confirm(`Are you sure you want to remove the entry "${entryToRemove.title}"?`)) return;

		const updatedDatabase: Database = deepCopyWithDates(database);
		const removeEntryFromGroup = (group: Group): boolean => {
			const index = group.entries.findIndex(e => e.id === entryToRemove.id);
			if (index !== -1) {
				group.entries.splice(index, 1);
				return true;
			}
			for (const subgroup of group.groups) {
				if (removeEntryFromGroup(subgroup)) return true;
			}
			return false;
		};

		removeEntryFromGroup(updatedDatabase.root);
		if (selectedEntry?.id === entryToRemove.id) {
			setSelectedEntry(null);
		}
		onDatabaseChange?.(updatedDatabase);
	};

	const countEntriesInGroup = (group: Group): number => {
		let count = group.entries.length;
		group.groups.forEach(subgroup => {
			count += countEntriesInGroup(subgroup);
		});
		return count;
	};

	// Add helper function to find a group by ID
	const findGroupInDatabase = (groupId: string, root: Group): Group | null => {
		if (root.id === groupId) {
			return root;
		}
		for (const subgroup of root.groups) {
			const found = findGroupInDatabase(groupId, subgroup);
			if (found) return found;
		}
		return null;
	};

	const handleMoveEntry = (entryToMove: Entry, targetGroup: Group) => {
		const updatedDatabase: Database = deepCopyWithDates(database);

		// Find and remove the entry from its current group
		const removeEntryFromGroup = (group: Group): boolean => {
			const index = group.entries.findIndex(e => e.id === entryToMove.id);
			if (index !== -1) {
				group.entries.splice(index, 1);
				return true;
			}
			for (const subgroup of group.groups) {
				if (removeEntryFromGroup(subgroup)) return true;
			}
			return false;
		};

		// Find the target group
		const findTargetGroup = (group: Group): Group | null => {
			if (group.id === targetGroup.id) {
				return group;
			}
			for (const subgroup of group.groups) {
				const found = findTargetGroup(subgroup);
				if (found) return found;
			}
			return null;
		};

		// Remove from current group
		removeEntryFromGroup(updatedDatabase.root);

		// Add to target group
		const target = findTargetGroup(updatedDatabase.root);
		if (target) {
			target.entries.push(entryToMove);
		}

		onDatabaseChange?.(updatedDatabase);
	};

	return (
		<div className="password-view">
			<div className="password-view-content">
				<Sidebar
					database={database}
					selectedGroup={selectedGroup}
					onGroupSelect={handleGroupSelect}
					onNewGroup={handleNewGroup}
					onRemoveGroup={handleRemoveGroup}
					onGroupNameChange={handleGroupNameChange}
					onMoveGroup={handleMoveGroup}
					onMoveEntry={handleMoveEntry}
				/>
				<EntryList
					group={selectedGroup}
					searchQuery={searchQuery}
					selectedEntry={selectedEntry}
					onEntrySelect={setSelectedEntry}
					database={database}
					onNewEntry={handleNewEntry}
					onRemoveEntry={handleRemoveEntry}
					onMoveEntry={handleMoveEntry}
				/>
				{(selectedEntry || isCreatingNew) && (
					<EntryDetails
						key={isCreatingNew ? 'new' : selectedEntry?.id}
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
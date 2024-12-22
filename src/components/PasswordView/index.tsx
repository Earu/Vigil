import { useState, useEffect } from 'react';
import { Database, Entry, Group } from '../../types/database';
import { Sidebar } from './Sidebar';
import { EntryList } from './EntryList';
import { EntryDetails } from './EntryDetails';
import './PasswordView.css';

interface PasswordViewProps {
	database: Database;
	searchQuery: string;
}

export const PasswordView = ({ database, searchQuery }: PasswordViewProps) => {
	const [selectedGroup, setSelectedGroup] = useState<Group>(database.root);
	const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);

	// Clear selected entry when changing groups or search query
	useEffect(() => {
		setSelectedEntry(null);
	}, [selectedGroup.id, searchQuery]);

	const handleGroupSelect = (group: Group) => {
		setSelectedGroup(group);
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
				/>
				{selectedEntry && (
					<EntryDetails
						entry={selectedEntry}
						onClose={() => setSelectedEntry(null)}
					/>
				)}
			</div>
		</div>
	);
};
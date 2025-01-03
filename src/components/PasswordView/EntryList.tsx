import { Entry, Group, Database } from '../../types/database';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { BreachWarningIcon, SecurityShieldIcon } from '../../icons/status/StatusIcons';
import { AddActionIcon, KeyActionIcon, CloseActionIcon } from '../../icons/actions/ActionIcons';

interface EntryListProps {
	group: Group;
	searchQuery: string;
	selectedEntry: Entry | null;
	onEntrySelect: (entry: Entry) => void;
	database?: Database;
	onNewEntry: () => void;
	onRemoveEntry: (entry: Entry) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
}

export const EntryList = ({
	group,
	searchQuery,
	selectedEntry,
	onEntrySelect,
	database,
	onNewEntry,
	onRemoveEntry,
	onMoveEntry,
}: EntryListProps) => {
	const sortedEntries = KeepassDatabaseService.getEntriesForDisplay(group, database, searchQuery);

	const handleDragStart = (e: React.DragEvent, entry: Entry) => {
		e.stopPropagation();
		e.dataTransfer.setData('application/json', JSON.stringify({ entryId: entry.id }));
		e.dataTransfer.effectAllowed = 'move';
		const target = e.target as HTMLElement;
		target.classList.add('dragging');
	};

	const handleDragEnd = (e: React.DragEvent) => {
		const target = e.target as HTMLElement;
		target.classList.remove('dragging');
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();

		try {
			const data = JSON.parse(e.dataTransfer.getData('application/json'));
			if (data.entryId) {
				const [draggedEntry] = KeepassDatabaseService.findEntry(data.entryId, database?.root || group);
				if (draggedEntry) {
					onMoveEntry?.(draggedEntry, group);
				}
			}
		} catch (err) {
			console.error('Error handling drop:', err);
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = 'move';
	};

	const getEntryStatus = (entry: Entry) => {
		const path = KeepassDatabaseService.getPath();
		if (!path) return null;
		return BreachStatusStore.getEntryStatus(path, entry.id);
	};

	return (
		<div
			className="entry-list"
			onDrop={handleDrop}
			onDragOver={handleDragOver}
		>
			<div className="entry-list-header">
				<div className="entry-list-header-content">
					<h2>{searchQuery ? 'Search Results' : group.name}</h2>
					<span className="entry-count">
						{searchQuery
							? `${sortedEntries.length} found`
							: `${KeepassDatabaseService.getAllEntriesFromGroup(group).length} entries`}
					</span>
				</div>
				{!searchQuery && (
					<button className="new-entry-button" onClick={onNewEntry} title="Add new entry">
						<AddActionIcon />
						New Entry
					</button>
				)}
			</div>
			<div className="entries">
				{sortedEntries.map((entry) => (
					<div
						key={entry.id}
						className={`entry-item ${selectedEntry?.id === entry.id ? 'selected' : ''}`}
						draggable={true}
						onDragStart={(e) => handleDragStart(e, entry)}
						onDragEnd={handleDragEnd}
						onClick={() => onEntrySelect(entry)}
					>
						<div className="entry-content">
							<div className="entry-icon">
								{entry.url ? (
									<img
										src={`https://www.google.com/s2/favicons?domain=${KeepassDatabaseService.getUrlHostname(entry.url)}&sz=32`}
										alt={entry.title}
										className="favicon"
										onError={(e) => {
											e.preventDefault();
											(e.target as HTMLImageElement).style.display = 'none';
										}}
									/>
								) : (
									<KeyActionIcon className="key-icon" />
								)}
							</div>
							<div className="entry-info">
								<div className="entry-title">
									{entry.title}
									{(() => {
										const status = getEntryStatus(entry);
										return (
											<>
												{status?.isPwned && (
													<span className="breach-indicator" title={`Password found in ${status.count} data breaches`}>
														<BreachWarningIcon className="breach-icon" />
													</span>
												)}
												{!status?.isPwned && ((status?.strength && status?.strength?.score < 3) || status?.breachedEmail) && (
													<span className="weak-password-indicator" title={
														status?.breachedEmail ? 'Email address found in data breaches' :
														status?.strength?.feedback.warning || 'Weak password detected'
													}>
														<SecurityShieldIcon className="weak-password-icon" />
													</span>
												)}
											</>
										);
									})()}
								</div>
								<div className="entry-username">{entry.username}</div>
							</div>
							{entry.url && (
								<div className="entry-url" title={entry.url}>
									{KeepassDatabaseService.getUrlHostname(entry.url)}
								</div>
							)}
						</div>
						<button
							className="remove-entry-button"
							onClick={() => onRemoveEntry(entry)}
							title="Remove entry"
						>
							<CloseActionIcon />
						</button>
					</div>
				))}
			</div>
		</div>
	);
};
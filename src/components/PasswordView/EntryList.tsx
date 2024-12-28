import { Entry, Group, Database } from '../../types/database';
import { DatabasePathService } from '../../services/DatabasePathService';
import { BreachStatusStore } from '../../services/BreachStatusStore';

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
	const getAllEntriesFromGroup = (group: Group): Entry[] => {
		let entries = [...group.entries];
		group.groups.forEach(subgroup => {
			entries = entries.concat(getAllEntriesFromGroup(subgroup));
		});
		return entries;
	};

	const baseEntries = group === database?.root || searchQuery
		? getAllEntriesFromGroup(group)
		: getAllEntriesFromGroup(group);

	const filteredEntries = baseEntries.filter(entry => {
		if (!searchQuery) return true;

		const searchLower = searchQuery.toLowerCase();
		return (
			entry.title.toLowerCase().includes(searchLower) ||
			entry.username.toLowerCase().includes(searchLower) ||
			(entry.url?.toLowerCase().includes(searchLower)) ||
			(entry.notes?.toLowerCase().includes(searchLower))
		);
	});

	const sortedEntries = [...filteredEntries].sort((a, b) =>
		a.title.toLowerCase().localeCompare(b.title.toLowerCase())
	);

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
				const draggedEntryId = data.entryId;
				const draggedEntry = getAllEntriesFromGroup(database?.root || group).find(e => e.id === draggedEntryId);
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
		const path = DatabasePathService.getPath();
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
							: `${getAllEntriesFromGroup(group).length} entries`}
					</span>
				</div>
				{!searchQuery && (
					<button className="new-entry-button" onClick={onNewEntry} title="Add new entry">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
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
										src={`https://www.google.com/s2/favicons?domain=${(() => {
											try {
												return new URL(entry.url).hostname;
											} catch {
												return '';
											}
										})()}&sz=32`}
										alt=""
										className="favicon"
										onError={(e) => {
											(e.target as HTMLImageElement).style.display = 'none';
										}}
									/>
								) : (
									<svg
										xmlns="http://www.w3.org/2000/svg"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										className="key-icon"
									>
										<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
									</svg>
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
														<svg
															xmlns="http://www.w3.org/2000/svg"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															strokeLinejoin="round"
															className="breach-icon"
														>
															<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
														</svg>
													</span>
												)}
												{!status?.isPwned && status?.strength && status.strength.score < 3 && (
													<span className="weak-password-indicator" title={status.strength.feedback.warning || 'Weak password detected'}>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															strokeLinejoin="round"
															className="weak-password-icon"
														>
															<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
															<line x1="12" y1="8" x2="12" y2="12" />
															<line x1="12" y1="16" x2="12.01" y2="16" />
														</svg>
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
									{(() => {
										try {
											return new URL(entry.url).hostname;
										} catch {
											return entry.url;
										}
									})()}
								</div>
							)}
						</div>
						<button
							className="remove-entry-button"
							onClick={() => onRemoveEntry(entry)}
							title="Remove entry"
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
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				))}
			</div>
		</div>
	);
};
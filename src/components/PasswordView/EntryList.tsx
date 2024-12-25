import { Entry, Group, Database } from '../../types/database';

interface EntryListProps {
	group: Group;
	searchQuery: string;
	selectedEntry: Entry | null;
	onEntrySelect: (entry: Entry) => void;
	database?: Database;
	onNewEntry: () => void;
}

export const EntryList = ({
	group,
	searchQuery,
	selectedEntry,
	onEntrySelect,
	database,
	onNewEntry,
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

	return (
		<div className="entry-list">
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
						onClick={() => onEntrySelect(entry)}
					>
						<div className="entry-icon">
							{entry.url ? (
								<img
									src={`https://www.google.com/s2/favicons?domain=${new URL(entry.url).hostname}&sz=32`}
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
							<div className="entry-title">{entry.title}</div>
							<div className="entry-username">{entry.username}</div>
						</div>
						{entry.url && (
							<div className="entry-url" title={entry.url}>
								{new URL(entry.url).hostname}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
};
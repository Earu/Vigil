import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Entry, Group, Database } from '../../types/database';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { BreachWarningIcon, SecurityShieldIcon, ExpiredClockIcon } from '../../icons/status/StatusIcons';
import { AddActionIcon, KeyActionIcon, CloseActionIcon, TrashActionIcon, RestoreActionIcon } from '../../icons/actions/ActionIcons';
import { userSettingsService } from '../../services/UserSettingsService';

interface EntryListProps {
	group: Group;
	searchQuery: string;
	selectedEntry: Entry | null;
	onEntrySelect: (entry: Entry) => void;
	database?: Database;
	onNewEntry: () => void;
	onRemoveEntry: (entry: Entry) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
	onEmptyRecycleBin?: () => void;
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
	onEmptyRecycleBin,
}: EntryListProps) => {
	// Re-render when breach statuses change so the indicators stay current
	useSyncExternalStore(BreachStatusStore.subscribe, BreachStatusStore.getVersion);
	useSyncExternalStore(userSettingsService.subscribe, userSettingsService.getVersion);
	const showFavicons = userSettingsService.getFetchFavicons();

	const sortedEntries = useMemo(
		() => KeepassDatabaseService.getEntriesForDisplay(group, database, searchQuery),
		[group, database, searchQuery]
	);
	const totalEntryCount = useMemo(
		() => KeepassDatabaseService.getAllEntriesFromGroup(group).length,
		[group]
	);
	// Membership set instead of a per-row tree walk (O(n²) on large lists)
	const recycleBinEntryIds = useMemo(() => {
		const bin = database ? KeepassDatabaseService.findRecycleBin(database.root) : null;
		if (!bin) return new Set<string>();
		return new Set(KeepassDatabaseService.getAllEntriesFromGroup(bin).map(e => e.id));
	}, [database]);

	// Windowed rendering: only the rows in (and around) the viewport exist in
	// the DOM; spacer divs keep the scrollbar geometry of the full list
	const OVERSCAN = 10;
	const entriesRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(600);
	const [rowHeight, setRowHeight] = useState(44);

	useLayoutEffect(() => {
		const el = entriesRef.current;
		if (!el) return;
		const measure = () => setViewportHeight(el.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		const el = entriesRef.current;
		if (el) el.scrollTop = 0;
		setScrollTop(0);
	}, [group, searchQuery]);

	// Row height comes from CSS; measure a real row once instead of guessing.
	// Measuring on every render loops forever when rows have unequal heights:
	// setRowHeight shifts the window, a different row lands first, and its
	// different height triggers another setRowHeight
	const rowHeightMeasured = useRef(false);
	useLayoutEffect(() => {
		if (rowHeightMeasured.current) return;
		const first = entriesRef.current?.querySelector('.entry-item') as HTMLElement | null;
		if (first && first.offsetHeight > 0) {
			rowHeightMeasured.current = true;
			if (Math.abs(first.offsetHeight - rowHeight) > 1) {
				setRowHeight(first.offsetHeight);
			}
		}
	});

	const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
	const endIndex = Math.min(sortedEntries.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN);
	const visibleEntries = sortedEntries.slice(startIndex, endIndex);

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
		const status = BreachStatusStore.getEntryStatus(path, entry.id);
		if (!status) return null;
		// Passwordless entries (passkey-only) can't have a breached or weak
		// password; drop those flags even from a stale cached status
		if (!KeepassDatabaseService.getPasswordString(entry.password)) {
			return { ...status, isPwned: false, strength: null };
		}
		return status;
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
							: `${totalEntryCount} entries`}
					</span>
				</div>
				{!searchQuery && (
					group.isRecycleBin ? (
						sortedEntries.length > 0 && onEmptyRecycleBin && (
							<button className="new-entry-button empty-bin-button" onClick={onEmptyRecycleBin} title="Permanently delete everything in the recycle bin">
								<TrashActionIcon />
								Empty Bin
							</button>
						)
					) : (
						<button className="new-entry-button" onClick={onNewEntry} title="Add new entry">
							<AddActionIcon />
							New Entry
						</button>
					)
				)}
			</div>
			<div
				className="entries"
				ref={entriesRef}
				onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
			>
				<div style={{ height: startIndex * rowHeight }} aria-hidden="true" />
				{visibleEntries.map((entry) => (
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
								{entry.url && showFavicons ? (
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
									{KeepassDatabaseService.isEntryExpired(entry) && (
										<span className="expired-indicator" title={`Expired ${entry.expiryTime?.toLocaleString()}`}>
											<ExpiredClockIcon className="expired-icon" />
										</span>
									)}
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
						{database && onMoveEntry && recycleBinEntryIds.has(entry.id) && (
							<button
								className="restore-entry-button"
								onClick={(e) => {
									e.stopPropagation();
									onMoveEntry(entry, database.root);
								}}
								title="Restore entry"
							>
								<RestoreActionIcon />
							</button>
						)}
						<button
							className="remove-entry-button"
							onClick={() => onRemoveEntry(entry)}
							title="Remove entry"
						>
							<CloseActionIcon />
						</button>
					</div>
				))}
				<div style={{ height: Math.max(0, (sortedEntries.length - endIndex) * rowHeight) }} aria-hidden="true" />
			</div>
		</div>
	);
};
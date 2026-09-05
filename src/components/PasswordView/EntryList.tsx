import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Entry, Group, Database } from '../../types/database';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { BreachWarningIcon, SecurityShieldIcon, ExpiredClockIcon } from '../../icons/status/StatusIcons';
import { AddActionIcon, KeyActionIcon, CloseActionIcon, TrashActionIcon, RestoreActionIcon, PasskeyActionIcon } from '../../icons/actions/ActionIcons';
import { ItemIcon } from './ItemIcon';
import { BrowserIntegrationService } from '../../services/BrowserIntegrationService';
import { PasskeyService } from '../../services/PasskeyService';
import { PlaceholderService } from '../../services/PlaceholderService';
import { userSettingsService } from '../../services/UserSettingsService';
import { isTypeAheadKey, useTypeAhead } from '../typeAhead';

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
	// Present only while a search is scoped to a subgroup; widens it to the root
	onSearchEverywhere?: () => void;
	// Enter on a row: the caller moves focus into the details panel
	onOpenEntry?: (entry: Entry) => void;
	// The scrolling grid element, for a caller that hands focus back to it
	gridRef?: React.Ref<HTMLDivElement>;
}

// Entry ids are base64 and may hold characters that are awkward in an id
// attribute; base64url is the same id, one to one
const rowId = (entryId: string) => `entry-row-${entryId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

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
	onSearchEverywhere,
	onOpenEntry,
	gridRef,
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
	const entriesRef = useRef<HTMLDivElement | null>(null);
	const setEntriesRef = (el: HTMLDivElement | null) => {
		entriesRef.current = el;
		if (typeof gridRef === 'function') gridRef(el);
		else if (gridRef) (gridRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
	};
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

	// Keyed on the group id, not the object: every save rebuilds the model, so
	// depending on identity here sent the list back to the top after each edit
	useLayoutEffect(() => {
		const el = entriesRef.current;
		if (el) el.scrollTop = 0;
		setScrollTop(0);
		setActiveId(null);
	}, [group.id, searchQuery]);

	// Keyboard focus stays on the grid; the row it is "on" is the active
	// descendant. Rows unmount when scrolled out of the window, so focusing
	// them directly would lose focus
	const [activeId, setActiveId] = useState<string | null>(null);
	const lastActiveIndex = useRef(0);
	const activeIndex = activeId ? sortedEntries.findIndex((e) => e.id === activeId) : -1;
	if (activeIndex >= 0) lastActiveIndex.current = activeIndex;

	// A click selects through the parent; the active row follows
	useEffect(() => {
		if (selectedEntry) setActiveId(selectedEntry.id);
	}, [selectedEntry?.id]);

	// After a removal the active row is gone; land on its neighbour
	useEffect(() => {
		if (activeId && activeIndex < 0) {
			setActiveId(sortedEntries[Math.min(lastActiveIndex.current, sortedEntries.length - 1)]?.id ?? null);
		}
	}, [sortedEntries, activeId, activeIndex]);

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

	// The estimate above gets the row rendered; this lines it up exactly,
	// which matters when rows turned out taller than the one measured
	const snapToActive = useRef(false);
	useLayoutEffect(() => {
		if (!snapToActive.current || !activeId) return;
		snapToActive.current = false;
		const row = document.getElementById(rowId(activeId));
		if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
	}, [activeId]);

	// The scroll and the active row change in the same event, so the row
	// referenced by aria-activedescendant is rendered in the same commit.
	// Nothing else sets the active row by index
	const moveTo = (index: number) => {
		if (sortedEntries.length === 0) return;
		const i = Math.max(0, Math.min(sortedEntries.length - 1, index));
		const el = entriesRef.current;
		if (el) {
			const top = i * rowHeight;
			const bottom = top + rowHeight;
			let next = el.scrollTop;
			if (top < next) next = top;
			else if (bottom > next + viewportHeight) next = bottom - viewportHeight;
			if (next !== el.scrollTop) {
				el.scrollTop = next;
				setScrollTop(next);
			}
		}
		const entry = sortedEntries[i];
		snapToActive.current = true;
		setActiveId(entry.id);
		onEntrySelect(entry);
	};

	const typeAhead = useTypeAhead();
	const handleGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		// Keys from a row's buttons are their own
		if (e.target !== e.currentTarget) return;
		if (isTypeAheadKey(e)) {
			e.preventDefault();
			const i = typeAhead(e.key, sortedEntries.map((entry) => displayText(entry.title, entry)), activeIndex);
			if (i >= 0) moveTo(i);
			return;
		}
		const pageSize = Math.max(1, Math.floor(viewportHeight / rowHeight));
		const active = activeIndex >= 0 ? sortedEntries[activeIndex] : null;
		switch (e.key) {
			case 'ArrowDown': e.preventDefault(); moveTo(activeIndex < 0 ? 0 : activeIndex + 1); return;
			case 'ArrowUp': e.preventDefault(); moveTo(activeIndex < 0 ? sortedEntries.length - 1 : activeIndex - 1); return;
			case 'Home': e.preventDefault(); moveTo(0); return;
			case 'End': e.preventDefault(); moveTo(sortedEntries.length - 1); return;
			case 'PageDown': e.preventDefault(); moveTo(Math.max(0, activeIndex) + pageSize); return;
			case 'PageUp': e.preventDefault(); moveTo(Math.max(0, activeIndex) - pageSize); return;
			case 'Enter':
				if (!active) return;
				e.preventDefault();
				if (selectedEntry?.id !== active.id) onEntrySelect(active);
				onOpenEntry?.(active);
				return;
			case 'Delete':
				if (!active) return;
				e.preventDefault();
				onRemoveEntry(active);
				return;
		}
	};

	const handleGridFocus = (e: React.FocusEvent<HTMLDivElement>) => {
		if (e.target !== e.currentTarget || activeId !== null || sortedEntries.length === 0) return;
		setActiveId(selectedEntry?.id ?? sortedEntries[0].id);
	};

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

	// Titles and usernames may hold KeePass placeholders and {REF:...}
	// references; the list shows them resolved, the model keeps the raw text
	const displayText = (text: string, entry: Entry) =>
		PlaceholderService.displayField(text, entry);

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
					<h2>{searchQuery ? `Search in ${group.name}` : group.name}</h2>
					<span className="entry-count" aria-live="polite" aria-atomic="true">
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
				ref={setEntriesRef}
				role="grid"
				aria-label={searchQuery ? 'Search results' : 'Entries'}
				aria-rowcount={sortedEntries.length}
				aria-activedescendant={activeIndex >= 0 ? rowId(activeId!) : undefined}
				tabIndex={0}
				onKeyDown={handleGridKeyDown}
				onFocus={handleGridFocus}
				onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
			>
				<div style={{ height: startIndex * rowHeight }} aria-hidden="true" />
				{visibleEntries.map((entry, i) => (
					<div
						key={entry.id}
						id={rowId(entry.id)}
						role="row"
						aria-rowindex={startIndex + i + 1}
						aria-selected={selectedEntry?.id === entry.id}
						className={`entry-item ${selectedEntry?.id === entry.id ? 'selected' : ''} ${activeId === entry.id ? 'active' : ''}`}
						draggable={true}
						onDragStart={(e) => handleDragStart(e, entry)}
						onDragEnd={handleDragEnd}
						onClick={() => onEntrySelect(entry)}
					>
						<div className="entry-content" role="gridcell">
							<div className="entry-icon">
								<ItemIcon
									icon={entry.icon}
									customIcon={entry.customIcon}
									className={entry.customIcon ? 'favicon' : 'key-icon'}
									fallback={entry.url && showFavicons && !entry.suppressFavicon ? (
										// Stand-in until promotion stores the icon; the
										// host must match the one promotion fetches, or
										// the icon visibly changes once stored
										<img
											src={`https://www.google.com/s2/favicons?domain=${BrowserIntegrationService.hostOf(entry.url)}&sz=32`}
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
								/>
							</div>
							<div className="entry-info">
								<div className="entry-title">
									{displayText(entry.title, entry)}
									{KeepassDatabaseService.isEntryExpired(entry) && (
										<span className="expired-indicator" role="img" title={`Expired ${entry.expiryTime?.toLocaleString()}`} aria-label={`Expired ${entry.expiryTime?.toLocaleString()}`}>
											<ExpiredClockIcon className="expired-icon" />
										</span>
									)}
									{PasskeyService.passkeyFromFields(entry.customFields) && (
										<span className="passkey-indicator" role="img" title="This entry holds a passkey" aria-label="This entry holds a passkey">
											<PasskeyActionIcon className="passkey-list-icon" />
										</span>
									)}
									{(() => {
										const status = getEntryStatus(entry);
										return (
											<>
												{status?.isPwned && (
													<span className="breach-indicator" role="img" title={`Password found in ${status.count} data breaches`} aria-label={`Password found in ${status.count} data breaches`}>
														<BreachWarningIcon className="breach-icon" />
													</span>
												)}
												{!status?.isPwned && ((status?.strength && status?.strength?.score < 3) || status?.breachedEmail) && (
													<span className="weak-password-indicator" role="img" title={
														status?.breachedEmail ? 'Email address found in data breaches' :
														status?.strength?.feedback.warning || 'Weak password'
													} aria-label={
														status?.breachedEmail ? 'Email address found in data breaches' :
														status?.strength?.feedback.warning || 'Weak password'
													}>
														<SecurityShieldIcon className="weak-password-icon" />
													</span>
												)}
											</>
										);
									})()}
								</div>
								<div className="entry-username">{displayText(entry.username, entry)}</div>
							</div>
							{entry.url && (
								<div className="entry-url" title={entry.url}>
									{KeepassDatabaseService.getUrlHostname(entry.url)}
								</div>
							)}
						</div>
						{database && onMoveEntry && recycleBinEntryIds.has(entry.id) && (
							<div className="entry-cell-action" role="gridcell">
								<button
									className="restore-entry-button"
									onClick={(e) => {
										e.stopPropagation();
										onMoveEntry(entry, KeepassDatabaseService.restoreTargetGroup(database, entry));
									}}
									title="Restore entry" aria-label="Restore entry"
								>
									<RestoreActionIcon />
								</button>
							</div>
						)}
						<div className="entry-cell-action" role="gridcell">
							<button
								className="remove-entry-button"
								onClick={() => onRemoveEntry(entry)}
								title="Remove entry" aria-label="Remove entry"
							>
								<CloseActionIcon />
							</button>
						</div>
					</div>
				))}
				<div style={{ height: Math.max(0, (sortedEntries.length - endIndex) * rowHeight) }} aria-hidden="true" />
				{searchQuery && onSearchEverywhere && (
					<div className="search-scope-note">
						<button className="search-everywhere-button" onClick={onSearchEverywhere}>
							Search entire database
						</button>
					</div>
				)}
			</div>
		</div>
	);
};
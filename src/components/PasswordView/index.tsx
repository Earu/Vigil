import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { Database, Entry, Group } from '../../types/database';
import { Sidebar } from './Sidebar';
import { EntryList } from './EntryList';
import { EntryDetails } from './EntryDetails';
import { BreachReport } from './BreachReport';
import { BreachCheckService, BreachedEntry, BreachedEmailEntry } from '../../services/BreachCheckService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import './PasswordView.css';
import { userSettingsService } from '../../services/UserSettingsService';

interface PasswordViewProps {
	database: Database;
	searchQuery: string;
	onDatabaseChange?: (database: Database) => void;
	showInitialBreachReport?: boolean;
	securityReportRequestId?: number;
	// Owned by App so locking can see the edit form's state; see entryDirty there
	entryDirty: React.MutableRefObject<boolean>;
	// Owned by App: true while a failed save leaves the in-memory vault ahead
	// of the file. Read here so closing an edit form does not clear the main
	// process's unsaved-changes flag while that state persists
	saveFailed: React.MutableRefObject<boolean>;
	// Clicking a tag rewrites the search box, which App owns
	onSearch?: (query: string) => void;
}

export const PasswordView = ({ database, searchQuery, onDatabaseChange, showInitialBreachReport, securityReportRequestId, entryDirty, saveFailed, onSearch }: PasswordViewProps) => {
	const [selectedGroup, setSelectedGroup] = useState<Group>(database.root);
	const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
	const [isCreatingNew, setIsCreatingNew] = useState(false);
	const [breachedEntries, setBreachedEntries] = useState<BreachedEntry[]>([]);
	const [weakEntries, setWeakEntries] = useState<BreachedEntry[]>([]);
	const [breachedEmailEntries, setBreachedEmailEntries] = useState<BreachedEmailEntry[]>([]);
	const [showBreachReport, setShowBreachReport] = useState(false);
	const [reportOpenedManually, setReportOpenedManually] = useState(false);
	const [isCheckingBreaches, setIsCheckingBreaches] = useState(false);
	const [isCheckingEmails, setIsCheckingEmails] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(260);
	const [detailsWidth, setDetailsWidth] = useState(340);
	const [isResizing, setIsResizing] = useState<'left' | 'right' | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);

	// Recompute breach state as background check results come in
	const breachStoreVersion = useSyncExternalStore(BreachStatusStore.subscribe, BreachStatusStore.getVersion);
	const emailStoreVersion = useSyncExternalStore(EmailBreachStatusStore.subscribe, EmailBreachStatusStore.getVersion);

	// Derived from the model alone, no network involved
	const expiredEntries = useMemo(
		() => KeepassDatabaseService.findExpiredEntries(database.root),
		[database]
	);
	const reusedPasswords = useMemo(
		() => BreachCheckService.findReusedPasswords(database.root),
		[database]
	);
	const allTags = useMemo(
		() => KeepassDatabaseService.collectTags(database.root),
		[database]
	);
	const reusedEntryCount = useMemo(
		() => reusedPasswords.reduce((total, cluster) => total + cluster.count, 0),
		[reusedPasswords]
	);

	// Every group's indicators and entry count in one pass, so the sidebar
	// looks them up instead of re-walking its subtree per node per update
	const groupSummaries = useMemo(
		() => BreachCheckService.buildGroupSummaries(database.root),
		[database, breachStoreVersion, emailStoreVersion]
	);

	useEffect(() => {
		if (showInitialBreachReport) {
			setShowBreachReport(true);
			setIsCheckingBreaches(true);
			setIsCheckingEmails(true);
		}
	}, [showInitialBreachReport]);

	// Title bar shield button: open the report even when nothing was found
	useEffect(() => {
		if (!securityReportRequestId) return;
		const { breached, weak } = BreachCheckService.findBreachedAndWeakEntries(database.root);
		setBreachedEntries(breached);
		setWeakEntries(weak);
		if (userSettingsService.getHibpApiKey() != null) {
			setBreachedEmailEntries(BreachCheckService.findBreachedEmails(database.root).breached);
		}
		setReportOpenedManually(true);
		setShowBreachReport(true);
	}, [securityReportRequestId]);

	useEffect(() => {
		const updateBreachStatus = () => {
			const { breached, weak, allEntriesCached } = BreachCheckService.findBreachedAndWeakEntries(database.root);
			setBreachedEntries(breached);
			setWeakEntries(weak);

			// Done when there is something to show, or when every entry has a
			// cached verdict (a clean vault would otherwise spin forever)
			if (isCheckingBreaches && (breached.length > 0 || weak.length > 0 || allEntriesCached)) {
				setIsCheckingBreaches(false);
			}
		};

		const updateEmailBreachStatus = () => {
			const hasApikey = userSettingsService.getHibpApiKey() != null;
			if (!hasApikey) {
				setIsCheckingEmails(false);
				return;
			}

			const { breached, allEmailsCached } = BreachCheckService.findBreachedEmails(database.root);
			setBreachedEmailEntries(breached);

			if (isCheckingEmails && (breached.length > 0 || allEmailsCached)) {
				setIsCheckingEmails(false);
			}
		};

		updateBreachStatus();
		updateEmailBreachStatus();
	}, [database, isCheckingBreaches, isCheckingEmails, breachStoreVersion, emailStoreVersion]);

	useEffect(() => {
		const updatedGroup = KeepassDatabaseService.findGroupInDatabase(selectedGroup.id, database.root);
		if (updatedGroup) {
			setSelectedGroup(updatedGroup);
		} else {
			setSelectedGroup(database.root);
		}

		// Keep the open entry in sync with the refreshed model (history grows
		// after a save, and the save path re-reads the model from the kdbx)
		if (selectedEntry) {
			const [updatedEntry] = KeepassDatabaseService.findEntry(selectedEntry.id, database.root);
			if (updatedEntry) {
				setSelectedEntry(updatedEntry);
			}
		}
	}, [database]);

	useEffect(() => {
		setSelectedEntry(null);
		setIsCreatingNew(false);
	}, [selectedGroup.id, searchQuery]);

	// Set by EntryDetails while its edit form holds unsaved changes; a ref
	// because it must be readable synchronously inside click handlers. It lives
	// in App rather than here because locking has to consult it too
	const detailsDirty = entryDirty;
	// The main process needs it too: closing the window (title bar button, the
	// macOS traffic light, Cmd+W, Alt+F4) never reaches this renderer state,
	// so it is mirrored over IPC and the close handler consults it there
	const setDirty = (dirty: boolean) => {
		if (detailsDirty.current === dirty) return;
		detailsDirty.current = dirty;
		window.electron?.setUnsavedChanges(dirty || saveFailed.current).catch(() => {});
	};
	const handleDirtyChange = (dirty: boolean) => setDirty(dirty);

	const confirmDiscardEdits = (): boolean => {
		if (!detailsDirty.current) return true;
		if (!window.confirm('Discard unsaved changes to this entry?')) return false;
		setDirty(false);
		return true;
	};

	const handleGroupSelect = (group: Group) => {
		if (group.id !== selectedGroup.id && !confirmDiscardEdits()) return;
		const currentGroup = KeepassDatabaseService.findGroupInDatabase(group.id, database.root);
		setSelectedGroup(currentGroup || database.root);
	};

	const handleEntrySelect = (entry: Entry | null) => {
		if (entry?.id === selectedEntry?.id) return;
		if (!confirmDiscardEdits()) return;
		setSelectedEntry(entry);
	};

	const handleGroupNameChange = (group: Group, newName: string) => {
		const updatedDatabase = KeepassDatabaseService.updateGroupName(database, group, newName);
		onDatabaseChange?.(updatedDatabase);
	};

	const handleSaveEntry = (entry: Entry) => {
		const [updatedDatabase, savedEntry] = KeepassDatabaseService.saveEntry(database, entry, selectedGroup, isCreatingNew);
		setSelectedEntry(savedEntry);
		setIsCreatingNew(false);
		onDatabaseChange?.(updatedDatabase);
	};

	// A tag is only useful as a filter if it reaches the whole vault, so this
	// widens the selection to the root rather than searching inside whatever
	// group the entry happened to live in
	const handleTagClick = (tag: string) => {
		if (!confirmDiscardEdits()) return;
		setSelectedGroup(database.root);
		onSearch?.(`tag:"${tag}"`);
	};

	const handleNewEntry = () => {
		if (!confirmDiscardEdits()) return;
		setIsCreatingNew(true);
		setSelectedEntry(null);
	};

	const handleCloseEntry = () => {
		setSelectedEntry(null);
		setIsCreatingNew(false);
	};

	const handleNewGroup = (parentGroup: Group) => {
		const updatedDatabase = KeepassDatabaseService.addNewGroup(database, parentGroup);
		onDatabaseChange?.(updatedDatabase);
	};

	const handleRemoveGroup = (groupToRemove: Group) => {
		if (groupToRemove.id === database.root.id) return;

		const totalEntries = KeepassDatabaseService.countEntriesInGroup(groupToRemove);
		const permanent = KeepassDatabaseService.isGroupInRecycleBin(database, groupToRemove);
		const message = permanent
			? `Permanently delete the group "${groupToRemove.name}" and all its contents (${totalEntries} entries, ${groupToRemove.groups.length} subgroups)? This cannot be undone.`
			: `Move the group "${groupToRemove.name}" and all its contents (${totalEntries} entries, ${groupToRemove.groups.length} subgroups) to the recycle bin?`;

		if (!window.confirm(message)) return;

		const updatedDatabase = KeepassDatabaseService.removeGroup(database, groupToRemove);
		if (selectedGroup.id === groupToRemove.id) {
			setSelectedGroup(updatedDatabase.root);
		}
		onDatabaseChange?.(updatedDatabase);
	};

	const handleMoveGroup = (groupToMove: Group, newParent: Group) => {
		const updatedDatabase = KeepassDatabaseService.moveGroup(database, groupToMove, newParent);
		onDatabaseChange?.(updatedDatabase);
	};

	const handleEmptyRecycleBin = () => {
		const bin = KeepassDatabaseService.findRecycleBin(database.root);
		if (!bin) return;

		const count = KeepassDatabaseService.countEntriesInGroup(bin);
		if (!window.confirm(`Permanently delete everything in the recycle bin (${count} ${count === 1 ? 'entry' : 'entries'})? This cannot be undone.`)) return;

		onDatabaseChange?.(KeepassDatabaseService.emptyRecycleBin(database));
	};

	const handleRemoveEntry = (entryToRemove: Entry) => {
		const permanent = KeepassDatabaseService.isEntryInRecycleBin(database, entryToRemove.id);
		const message = permanent
			? `Permanently delete the entry "${entryToRemove.title}"? This cannot be undone.`
			: `Move the entry "${entryToRemove.title}" to the recycle bin?`;
		if (!window.confirm(message)) return;

		const updatedDatabase = KeepassDatabaseService.removeEntry(database, entryToRemove);
		if (selectedEntry?.id === entryToRemove.id) {
			setSelectedEntry(null);
		}
		onDatabaseChange?.(updatedDatabase);
	};

	const handleMoveEntry = (entryToMove: Entry, targetGroup: Group) => {
		const updatedDatabase = KeepassDatabaseService.moveEntry(database, entryToMove, targetGroup);
		onDatabaseChange?.(updatedDatabase);
	};

	const handleResizeStart = (side: 'left' | 'right') => (e: React.MouseEvent) => {
		e.preventDefault();
		setIsResizing(side);

		const startX = e.clientX;
		const startWidth = side === 'left' ? sidebarWidth : detailsWidth;
		const contentRect = contentRef.current?.getBoundingClientRect();
		const contentElement = contentRef.current;

		if (!contentElement || !contentRect) return;

		const handleMouseMove = (e: MouseEvent) => {
			const delta = e.clientX - startX;
			const newWidth = side === 'left'
				? Math.max(200, Math.min(startWidth + delta, contentRect.width - 600))
				: Math.max(200, Math.min(startWidth - delta, contentRect.width - 600));

			contentElement.style.setProperty(
				side === 'left' ? '--sidebar-width' : '--details-width',
				`${newWidth}px`
			);
		};

		const handleMouseUp = () => {
			setIsResizing(null);
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);

			const finalWidth = parseInt(
				getComputedStyle(contentElement).getPropertyValue(
					side === 'left' ? '--sidebar-width' : '--details-width'
				)
			);
			if (side === 'left') {
				setSidebarWidth(finalWidth);
			} else {
				setDetailsWidth(finalWidth);
			}
		};

		document.addEventListener('mousemove', handleMouseMove);
		document.addEventListener('mouseup', handleMouseUp);
	};

	return (
		<div className="password-view">
			<div
				ref={contentRef}
				className="password-view-content"
				style={{
					'--sidebar-width': `${sidebarWidth}px`,
					'--details-width': `${detailsWidth}px`
				} as React.CSSProperties}
			>
				<Sidebar
					database={database}
					selectedGroup={selectedGroup}
					groupSummaries={groupSummaries}
					onGroupSelect={handleGroupSelect}
					onNewGroup={handleNewGroup}
					onRemoveGroup={handleRemoveGroup}
					onGroupNameChange={handleGroupNameChange}
					onMoveGroup={handleMoveGroup}
					onMoveEntry={handleMoveEntry}
					onDatabaseChange={onDatabaseChange}
				/>
				<div
					className={`resize-handle left ${isResizing === 'left' ? 'resizing' : ''}`}
					onMouseDown={handleResizeStart('left')}
				/>
				<EntryList
					group={selectedGroup}
					searchQuery={searchQuery}
					selectedEntry={selectedEntry}
					onEntrySelect={handleEntrySelect}
					database={database}
					onNewEntry={handleNewEntry}
					onRemoveEntry={handleRemoveEntry}
					onMoveEntry={handleMoveEntry}
					onEmptyRecycleBin={handleEmptyRecycleBin}
				/>
				<div
					className={`resize-handle right ${isResizing === 'right' ? 'resizing' : ''}`}
					onMouseDown={handleResizeStart('right')}
				/>
				{(selectedEntry || isCreatingNew) && (
					<EntryDetails
						entry={selectedEntry}
						onClose={handleCloseEntry}
						onSave={handleSaveEntry}
						isNew={isCreatingNew}
						onDirtyChange={handleDirtyChange}
						allTags={allTags}
						onTagClick={handleTagClick}
					/>
				)}
			</div>
			{(showBreachReport && (reportOpenedManually || breachedEntries.length > 0 || breachedEmailEntries.length > 0 || reusedPasswords.length > 0 || isCheckingBreaches || isCheckingEmails)) && (
				<BreachReport
					database={database}
					breachedEntries={breachedEntries}
					weakEntries={weakEntries}
					breachedEmailEntries={breachedEmailEntries}
					reusedPasswords={reusedPasswords}
					reusedEntryCount={reusedEntryCount}
					expiredEntries={expiredEntries}
					isChecking={isCheckingBreaches}
					isCheckingEmails={isCheckingEmails}
					onClose={() => {
						setShowBreachReport(false);
						setReportOpenedManually(false);
						setBreachedEntries([]);
						setWeakEntries([]);
						setBreachedEmailEntries([]);
						setIsCheckingBreaches(false);
						setIsCheckingEmails(false);
					}}
				/>
			)}
		</div>
	);
};
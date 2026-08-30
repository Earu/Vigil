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
}

export const PasswordView = ({ database, searchQuery, onDatabaseChange, showInitialBreachReport }: PasswordViewProps) => {
	const [selectedGroup, setSelectedGroup] = useState<Group>(database.root);
	const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
	const [isCreatingNew, setIsCreatingNew] = useState(false);
	const [breachedEntries, setBreachedEntries] = useState<BreachedEntry[]>([]);
	const [weakEntries, setWeakEntries] = useState<BreachedEntry[]>([]);
	const [breachedEmailEntries, setBreachedEmailEntries] = useState<BreachedEmailEntry[]>([]);
	const [showBreachReport, setShowBreachReport] = useState(false);
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

	useEffect(() => {
		if (showInitialBreachReport) {
			setShowBreachReport(true);
			setIsCheckingBreaches(true);
			setIsCheckingEmails(true);
		}
	}, [showInitialBreachReport]);

	useEffect(() => {
		const updateBreachStatus = () => {
			const { breached, weak } = BreachCheckService.findBreachedAndWeakEntries(database.root);
			setBreachedEntries(breached);
			setWeakEntries(weak);

			if (isCheckingBreaches && (breached.length > 0 || weak.length > 0)) {
				setIsCheckingBreaches(false);
			}
		};

		const updateEmailBreachStatus = () => {
			const hasApikey = userSettingsService.getHibpApiKey() != null;
			if (!hasApikey) {
				setIsCheckingEmails(false);
				return;
			}

			const { breached } = BreachCheckService.findBreachedEmails(database.root);
			setBreachedEmailEntries(breached);

			if (isCheckingEmails && breached.length > 0) {
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

	const handleGroupSelect = (group: Group) => {
		const currentGroup = KeepassDatabaseService.findGroupInDatabase(group.id, database.root);
		setSelectedGroup(currentGroup || database.root);
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

	const handleNewEntry = () => {
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
					onEntrySelect={setSelectedEntry}
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
					/>
				)}
			</div>
			{(showBreachReport && (breachedEntries.length > 0 || breachedEmailEntries.length > 0 || isCheckingBreaches || isCheckingEmails)) && (
				<BreachReport
					database={database}
					breachedEntries={breachedEntries}
					weakEntries={weakEntries}
					breachedEmailEntries={breachedEmailEntries}
					expiredEntries={expiredEntries}
					isChecking={isCheckingBreaches}
					isCheckingEmails={isCheckingEmails}
					onClose={() => {
						setShowBreachReport(false);
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
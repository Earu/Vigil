import { useState, useEffect, useRef } from 'react';
import { Database, Entry, Group } from '../../types/database';
import { Sidebar } from './Sidebar';
import { EntryList } from './EntryList';
import { EntryDetails } from './EntryDetails';
import { BreachReport } from './BreachReport';
import { BreachCheckService, BreachedEntry, BreachedEmailEntry } from '../../services/BreachCheckService';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import './PasswordView.css';

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
	const [sidebarWidth, setSidebarWidth] = useState(400);
	const [detailsWidth, setDetailsWidth] = useState(400);
	const [isResizing, setIsResizing] = useState<'left' | 'right' | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);

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
			const { breached } = BreachCheckService.findBreachedEmails(database.root);
			setBreachedEmailEntries(breached);

			if (isCheckingEmails && breached.length > 0) {
				setIsCheckingEmails(false);
			}
		};

		updateBreachStatus();
		updateEmailBreachStatus();
	}, [database, isCheckingBreaches, isCheckingEmails]);

	useEffect(() => {
		const checkBreaches = async () => {
			if (isCheckingBreaches) {
				try {
					const databasePath = KeepassDatabaseService.getPath();
					if (databasePath) {
						await BreachCheckService.checkGroup(databasePath, database.root);
						setIsCheckingBreaches(false);
					}
				} catch (error) {
					console.error('Error checking breaches:', error);
					setIsCheckingBreaches(false);
				}
			}
		};

		const checkEmails = async () => {
			if (isCheckingEmails) {
				try {
					const databasePath = KeepassDatabaseService.getPath();
					if (databasePath) {
						await BreachCheckService.checkGroupEmails(databasePath, database.root);
						setIsCheckingEmails(false);
					}
				} catch (error) {
					console.error('Error checking email breaches:', error);
					setIsCheckingEmails(false);
				}
			}
		};

		checkBreaches();
		checkEmails();
	}, [database, isCheckingBreaches, isCheckingEmails]);

	useEffect(() => {
		const updatedGroup = KeepassDatabaseService.findGroupInDatabase(selectedGroup.id, database.root);
		if (updatedGroup) {
			setSelectedGroup(updatedGroup);
		} else {
			setSelectedGroup(database.root);
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
		const updatedDatabase = KeepassDatabaseService.saveEntry(database, entry, selectedGroup, isCreatingNew);
		setSelectedEntry(entry);
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
		const message = `Are you sure you want to remove the group "${groupToRemove.name}" and all its contents? This will delete ${totalEntries} entries and ${groupToRemove.groups.length} subgroups.`;

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

	const handleRemoveEntry = (entryToRemove: Entry) => {
		if (!window.confirm(`Are you sure you want to remove the entry "${entryToRemove.title}"?`)) return;

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
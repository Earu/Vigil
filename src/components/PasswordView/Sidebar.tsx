import React, { useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Database, Group, Entry } from '../../types/database';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { BreachCheckService } from '../../services/BreachCheckService';
import { BreachStatusStore } from '../../services/BreachStatusStore';
import { EmailBreachStatusStore } from '../../services/EmailBreachStatusStore';
import { BreachWarningIcon, SecurityShieldIcon } from '../../icons/status/StatusIcons';
import { ChevronActionIcon, AddActionIcon, EditActionIcon, CloseActionIcon } from '../../icons/actions/ActionIcons';

interface SidebarProps {
	database: Database;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	onGroupNameChange?: (group: Group, newName: string) => void;
	onMoveGroup?: (group: Group, newParent: Group) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
	onDatabaseChange?: (database: Database) => void;
}

interface GroupItemProps {
	group: Group;
	level: number;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	onGroupNameChange?: (group: Group, newName: string) => void;
	onMoveGroup?: (group: Group, newParent: Group) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
	database: Database;
}

const GroupItem = ({ group, level, selectedGroup, onGroupSelect, onNewGroup, onRemoveGroup, onGroupNameChange, onMoveGroup, onMoveEntry, database }: GroupItemProps) => {
	const [isExpanded, setIsExpanded] = useState(true);
	const [isEditing, setIsEditing] = useState(false);
	const [editedName, setEditedName] = useState(group.name);
	const [isDragging, setIsDragging] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const hasSubgroups = group.groups.length > 0;

	// Derive breach indicators from the cached statuses. The network checks
	// run once at unlock (startBreachCheck); the store versions make these
	// recompute as results come in.
	const breachStoreVersion = useSyncExternalStore(BreachStatusStore.subscribe, BreachStatusStore.getVersion);
	const emailStoreVersion = useSyncExternalStore(EmailBreachStatusStore.subscribe, EmailBreachStatusStore.getVersion);
	const { hasBreachedEntries, hasWeakPasswords, hasBreachedEmails } = useMemo(() => ({
		hasBreachedEntries: BreachCheckService.hasBreachedPasswords(group),
		hasWeakPasswords: BreachCheckService.hasWeakPasswords(group),
		hasBreachedEmails: BreachCheckService.hasBreachedEmails(group),
	}), [group, breachStoreVersion, emailStoreVersion]);

	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	const handleNameSubmit = () => {
		if (editedName.trim() && editedName !== group.name) {
			onGroupNameChange?.(group, editedName.trim());
		} else {
			setEditedName(group.name);
		}
		setIsEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			handleNameSubmit();
		} else if (e.key === 'Escape') {
			setEditedName(group.name);
			setIsEditing(false);
		}
		e.stopPropagation();
	};

	const handleDragStart = (e: React.DragEvent) => {
		e.stopPropagation();
		if (group.id === database.root.id) {
			e.preventDefault();
			return;
		}
		setIsDragging(true);
		e.dataTransfer.setData('application/json', JSON.stringify({ groupId: group.id }));
		e.dataTransfer.effectAllowed = 'move';
	};

	const handleDragEnd = () => {
		setIsDragging(false);
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
		e.dataTransfer.dropEffect = 'move';
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		try {
			const data = JSON.parse(e.dataTransfer.getData('application/json'));

			// Handle group drops
			if (data.groupId) {
				const draggedGroupId = data.groupId;

				// Don't allow dropping on itself or root
				if (draggedGroupId === group.id || group.id === database.root.id) {
					return;
				}

				const draggedGroup = KeepassDatabaseService.findGroupInDatabase(draggedGroupId, database.root);
				if (!draggedGroup) return;

				// Don't allow dropping on a descendant
				if (KeepassDatabaseService.isGroupInHierarchy(group, draggedGroup)) {
					return;
				}

				onMoveGroup?.(draggedGroup, group);
			}
			// Handle entry drops
			else if (data.entryId) {
				const [draggedEntry, sourceGroup] = KeepassDatabaseService.findEntry(data.entryId, database.root);
				if (!draggedEntry || !sourceGroup || sourceGroup.id === group.id) return;

				onMoveEntry?.(draggedEntry, group);
			}
		} catch (err) {
			console.error('Error handling drop:', err);
		}
	};

	return (
		<div className="group-item">
			<div
				className={`group-header ${selectedGroup.id === group.id ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''} ${isDragging ? 'dragging' : ''}`}
				style={{ '--level': level } as React.CSSProperties}
				onClick={() => !isEditing && onGroupSelect(group)}
				draggable={!isEditing && group.id !== database.root.id}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{hasSubgroups && (
					<button
						className={`expand-button ${isExpanded ? 'expanded' : ''}`}
						onClick={(e) => {
							e.stopPropagation();
							setIsExpanded(!isExpanded);
						}}
					>
						<ChevronActionIcon className="chevron-icon" />
					</button>
				)}
				<div className="content-wrapper">
					{isEditing ? (
						<input
							ref={inputRef}
							className="group-name-input"
							value={editedName}
							onChange={(e) => setEditedName(e.target.value)}
							onBlur={handleNameSubmit}
							onKeyDown={handleKeyDown}
							onClick={(e) => e.stopPropagation()}
						/>
					) : (
						<span
							className="group-name"
							onDoubleClick={(e) => {
								e.stopPropagation();
								setIsEditing(true);
							}}
						>
							{group.name}
							{hasBreachedEntries && (
								<span className="group-breach-indicator" title="Contains breached passwords">
									<BreachWarningIcon className="breach-icon" />
								</span>
							)}
							{!hasBreachedEntries && (hasWeakPasswords || hasBreachedEmails) && (
								<span className="group-weak-password-indicator" title="Contains weak passwords or breached email addresses">
									<SecurityShieldIcon className="weak-password-icon" />
								</span>
							)}
						</span>
					)}
					<span className="entry-count">
						{KeepassDatabaseService.countEntriesInGroup(group)}
					</span>
					<div className="group-actions" onClick={(e) => e.stopPropagation()}>
						<button
							className="group-action-button"
							onClick={() => onNewGroup(group)}
							title="Add subgroup"
						>
							<AddActionIcon />
						</button>
						{!isEditing && (
							<button
								className="group-action-button"
								onClick={() => setIsEditing(true)}
								title="Edit group name"
							>
								<EditActionIcon />
							</button>
						)}
						{group.id !== database.root.id && (
							<button
								className="group-action-button"
								onClick={() => onRemoveGroup(group)}
								title="Remove group"
							>
								<CloseActionIcon />
							</button>
						)}
					</div>
				</div>
			</div>
			{isExpanded && hasSubgroups && (
				<div className="subgroups">
					{group.groups.map((subgroup) => (
						<GroupItem
							key={subgroup.id}
							group={subgroup}
							level={level + 1}
							selectedGroup={selectedGroup}
							onGroupSelect={onGroupSelect}
							onNewGroup={onNewGroup}
							onRemoveGroup={onRemoveGroup}
							onGroupNameChange={onGroupNameChange}
							onMoveGroup={onMoveGroup}
							onMoveEntry={onMoveEntry}
							database={database}
						/>
					))}
				</div>
			)}
		</div>
	);
};

export const Sidebar = ({ database, selectedGroup, onGroupSelect, onNewGroup, onRemoveGroup, onGroupNameChange, onMoveGroup, onMoveEntry, onDatabaseChange }: SidebarProps) => {
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [editedTitle, setEditedTitle] = useState(database.name);
	const titleInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isEditingTitle && titleInputRef.current) {
			titleInputRef.current.focus();
			titleInputRef.current.select();
		}
	}, [isEditingTitle]);

	useEffect(() => {
		setEditedTitle(database.name);
	}, [database.name]);

	const handleTitleSubmit = () => {
		const newTitle = editedTitle.trim();
		if (newTitle && newTitle !== database.name) {
			const updatedDatabase = { ...database, name: newTitle };
			onDatabaseChange?.(updatedDatabase);
		} else {
			setEditedTitle(database.name);
		}
		setIsEditingTitle(false);
	};

	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleTitleSubmit();
		} else if (e.key === 'Escape') {
			setEditedTitle(database.name);
			setIsEditingTitle(false);
		}
		e.stopPropagation();
	};

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				{isEditingTitle ? (
					<input
						ref={titleInputRef}
						className="database-title-input"
						value={editedTitle}
						onChange={(e) => setEditedTitle(e.target.value)}
						onBlur={handleTitleSubmit}
						onKeyDown={handleTitleKeyDown}
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<h2
						className="database-title"
						onClick={() => {
							setEditedTitle(database.name);
							setIsEditingTitle(true);
						}}
						title="Click to edit database name"
					>
						{database.name}
						<EditActionIcon className="edit-icon" />
					</h2>
				)}
			</div>
			<div className="groups-container">
				<GroupItem
					group={database.root}
					level={0}
					selectedGroup={selectedGroup}
					onGroupSelect={onGroupSelect}
					onNewGroup={onNewGroup}
					onRemoveGroup={onRemoveGroup}
					onGroupNameChange={onGroupNameChange}
					onMoveGroup={onMoveGroup}
					onMoveEntry={onMoveEntry}
					database={database}
				/>
			</div>
		</div>
	);
};
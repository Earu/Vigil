import { useState, useRef, useEffect } from 'react';
import { Database, Group, Entry } from '../../types/database';

interface SidebarProps {
	database: Database;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	onGroupNameChange?: (group: Group, newName: string) => void;
	onMoveGroup?: (group: Group, newParent: Group) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
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

	// Focus input when editing starts
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

	const getAllEntriesCount = (group: Group): number => {
		let count = group.entries.length;
		group.groups.forEach(subgroup => {
			count += getAllEntriesCount(subgroup);
		});
		return count;
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

	const isGroupInHierarchy = (targetGroup: Group, potentialParent: Group): boolean => {
		if (targetGroup.id === potentialParent.id) return true;
		return potentialParent.groups.some(g => isGroupInHierarchy(targetGroup, g));
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

				// Find the dragged group
				const findGroup = (searchGroup: Group): Group | null => {
					if (searchGroup.id === draggedGroupId) {
						return searchGroup;
					}
					for (const subgroup of searchGroup.groups) {
						const found = findGroup(subgroup);
						if (found) return found;
					}
					return null;
				};

				const draggedGroup = findGroup(database.root);
				if (!draggedGroup) return;

				// Don't allow dropping on a descendant
				if (isGroupInHierarchy(group, draggedGroup)) {
					return;
				}

				onMoveGroup?.(draggedGroup, group);
			}
			// Handle entry drops
			else if (data.entryId) {
				const draggedEntryId = data.entryId;

				// Find the dragged entry
				const findEntry = (searchGroup: Group): [Entry | null, Group | null] => {
					const entry = searchGroup.entries.find(e => e.id === draggedEntryId);
					if (entry) return [entry, searchGroup];
					
					for (const subgroup of searchGroup.groups) {
						const [found, sourceGroup] = findEntry(subgroup);
						if (found) return [found, sourceGroup];
					}
					return [null, null];
				};

				const [draggedEntry, sourceGroup] = findEntry(database.root);
				if (!draggedEntry || !sourceGroup) return;

				// Don't move to the same group
				if (sourceGroup.id === group.id) return;

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
				style={{ paddingLeft: `${level * 1.25}rem` }}
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
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="chevron-icon"
						>
							<polyline points="9 18 15 12 9 6" />
						</svg>
					</button>
				)}
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
					</span>
				)}
				<span className="entry-count">
					{getAllEntriesCount(group)}
				</span>
				<div className="group-actions" onClick={(e) => e.stopPropagation()}>
					<button
						className="group-action-button"
						onClick={() => onNewGroup(group)}
						title="Add subgroup"
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
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
					</button>
					{!isEditing && (
						<button
							className="group-action-button"
							onClick={() => setIsEditing(true)}
							title="Edit group name"
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
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
							</svg>
						</button>
					)}
					{group.id !== database.root.id && (
						<button
							className="group-action-button"
							onClick={() => onRemoveGroup(group)}
							title="Remove group"
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
					)}
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

export const Sidebar = ({ database, selectedGroup, onGroupSelect, onNewGroup, onRemoveGroup, onGroupNameChange, onMoveGroup, onMoveEntry }: SidebarProps) => {
	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<h2 className="database-title">{database.name}</h2>
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
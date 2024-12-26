import { useState, useRef, useEffect } from 'react';
import { Database, Group } from '../../types/database';

interface SidebarProps {
	database: Database;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	onGroupNameChange?: (group: Group, newName: string) => void;
}

interface GroupItemProps {
	group: Group;
	level: number;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	onGroupNameChange?: (group: Group, newName: string) => void;
	database: Database;
}

const GroupItem = ({ group, level, selectedGroup, onGroupSelect, onNewGroup, onRemoveGroup, onGroupNameChange, database }: GroupItemProps) => {
	const [isExpanded, setIsExpanded] = useState(true);
	const [isEditing, setIsEditing] = useState(false);
	const [editedName, setEditedName] = useState(group.name);
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

	return (
		<div className="group-item">
			<div
				className={`group-header ${selectedGroup.id === group.id ? 'selected' : ''}`}
				style={{ paddingLeft: `${level * 1.25}rem` }}
				onClick={() => !isEditing && onGroupSelect(group)}
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
							database={database}
						/>
					))}
				</div>
			)}
		</div>
	);
};

export const Sidebar = ({ database, selectedGroup, onGroupSelect, onNewGroup, onRemoveGroup, onGroupNameChange }: SidebarProps) => {
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
					database={database}
				/>
			</div>
		</div>
	);
};
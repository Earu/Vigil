import React, { useState, useRef, useEffect } from 'react';
import { Database, Group, Entry } from '../../types/database';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { GroupSummary } from '../../services/BreachCheckService';
import { BreachWarningIcon, SecurityShieldIcon } from '../../icons/status/StatusIcons';
import { ChevronActionIcon, AddActionIcon, EditActionIcon, CloseActionIcon, MoveActionIcon } from '../../icons/actions/ActionIcons';
import { ItemIcon } from './ItemIcon';

interface SidebarProps {
	database: Database;
	selectedGroup: Group;
	// Breach indicators and entry counts for every group, computed once per
	// change by PasswordView (see BreachCheckService.buildGroupSummaries)
	groupSummaries: Map<string, GroupSummary>;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	// Opens the group editing panel (name, icon); see GroupDetails
	onEditGroup?: (group: Group) => void;
	onMoveGroup?: (group: Group, newParent: Group) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
	onDatabaseChange?: (database: Database) => void;
	// Opens the destination picker (the keyboard route of drag-and-drop)
	onMoveGroupRequest?: (group: Group) => void;
	// The tree element, for a caller that wants to hand focus back to it
	treeRef?: React.RefObject<HTMLDivElement>;
}

interface GroupItemProps {
	group: Group;
	level: number;
	selectedGroup: Group;
	groupSummaries: Map<string, GroupSummary>;
	onGroupSelect: (group: Group) => void;
	onNewGroup: (parentGroup: Group) => void;
	onRemoveGroup: (group: Group) => void;
	// Opens the group editing panel (name, icon); see GroupDetails
	onEditGroup?: (group: Group) => void;
	onMoveGroup?: (group: Group, newParent: Group) => void;
	onMoveEntry?: (entry: Entry, targetGroup: Group) => void;
	onMoveGroupRequest?: (group: Group) => void;
	database: Database;
	collapsed: Set<string>;
	onToggle: (groupId: string) => void;
	// The one row reachable by Tab (roving tabindex)
	tabbableId: string;
	onRowFocus: (groupId: string) => void;
	// Selects a group by id, for arrow moves that land on another row
	onSelectId: (groupId: string) => void;
}

const EMPTY_SUMMARY: GroupSummary = { breached: false, weak: false, breachedEmail: false, entryCount: 0 };

// Rows in document order, which is visual order because collapsed subtrees
// are not rendered
const rowsOf = (row: HTMLElement): HTMLElement[] =>
	Array.from(row.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);

const parentRowOf = (row: HTMLElement): HTMLElement | null =>
	row.parentElement?.parentElement?.closest('.group-item')?.querySelector<HTMLElement>(':scope > .group-header') ?? null;

const GroupItem = ({ group, level, selectedGroup, groupSummaries, onGroupSelect, onNewGroup, onRemoveGroup, onEditGroup, onMoveGroup, onMoveEntry, onMoveGroupRequest, database, collapsed, onToggle, tabbableId, onRowFocus, onSelectId }: GroupItemProps) => {
	const isExpanded = !collapsed.has(group.id);
	const [isDragging, setIsDragging] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const hasSubgroups = group.groups.length > 0;
	const isRoot = group.id === database.root.id;

	// A group created in the UI has no id until the save assigns one, so a
	// missing summary is normal for one render
	const summary = groupSummaries.get(group.id) ?? EMPTY_SUMMARY;

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

				// Dropping on itself is meaningless. Root is a valid target: it is
				// where top-level groups live, and the only way out of the
				// recycle bin when no other top-level group exists
				if (draggedGroupId === group.id) {
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

	// Selection follows focus, as in a native tree view. Focus moves first so
	// a declined "discard changes?" prompt still leaves focus where it went
	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const row = e.currentTarget;
		const own = e.target === row;
		const go = (target: HTMLElement | null | undefined) => {
			e.preventDefault();
			if (!target) return;
			target.focus();
			onSelectId(target.dataset.groupId!);
		};
		switch (e.key) {
			case 'ArrowDown': { const rows = rowsOf(row); go(rows[rows.indexOf(row) + 1]); return; }
			case 'ArrowUp': { const rows = rowsOf(row); go(rows[rows.indexOf(row) - 1]); return; }
			case 'ArrowRight': {
				e.preventDefault();
				if (!hasSubgroups) return;
				if (!isExpanded) { onToggle(group.id); return; }
				const rows = rowsOf(row);
				go(rows[rows.indexOf(row) + 1]);
				return;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				if (hasSubgroups && isExpanded) { onToggle(group.id); return; }
				go(parentRowOf(row));
				return;
			}
			case 'Home': go(rowsOf(row)[0]); return;
			case 'End': { const rows = rowsOf(row); go(rows[rows.length - 1]); return; }
		}
		// Row actions only from the row itself, so Enter on a nested button
		// does not fire twice
		if (!own) return;
		switch (e.key) {
			case 'Enter':
			case ' ':
				e.preventDefault();
				onGroupSelect(group);
				return;
			case 'F2':
				if (!isRoot) { e.preventDefault(); onEditGroup?.(group); }
				return;
			case 'Delete':
				if (!isRoot) { e.preventDefault(); onRemoveGroup(group); }
				return;
			case 'Insert':
				e.preventDefault();
				onNewGroup(group);
				return;
		}
	};

	const count = summary.entryCount;
	const label = [
		group.name || '(unnamed group)',
		`${count} ${count === 1 ? 'entry' : 'entries'}`,
		summary.breached ? 'contains breached passwords' : '',
		!summary.breached && (summary.weak || summary.breachedEmail) ? 'contains weak passwords or breached email addresses' : '',
	].filter(Boolean).join(', ');

	return (
		<div className="group-item">
			<div
				className={`group-header ${selectedGroup.id === group.id ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''} ${isDragging ? 'dragging' : ''}`}
				style={{ '--level': level } as React.CSSProperties}
				role="treeitem"
				aria-level={level + 1}
				aria-selected={selectedGroup.id === group.id}
				aria-expanded={hasSubgroups ? isExpanded : undefined}
				aria-label={label}
				tabIndex={tabbableId === group.id ? 0 : -1}
				data-group-id={group.id}
				onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus(group.id); }}
				onKeyDown={handleKeyDown}
				onClick={() => onGroupSelect(group)}
				draggable={!isRoot}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{hasSubgroups && (
					<button
						className={`expand-button ${isExpanded ? 'expanded' : ''}`}
						aria-label={isExpanded ? 'Collapse' : 'Expand'}
						tabIndex={-1}
						onClick={(e) => {
							e.stopPropagation();
							onToggle(group.id);
						}}
					>
						<ChevronActionIcon className="chevron-icon" />
					</button>
				)}
				<div className="content-wrapper">
					<span
						className="group-name"
						onDoubleClick={(e) => {
							e.stopPropagation();
							if (group.id !== database.root.id) onEditGroup?.(group);
						}}
					>
							{group.id !== database.root.id && (
								// Only an icon that says something: the folder
								// defaults would just repeat what a group already is
								<ItemIcon
									icon={group.icon === 49 ? undefined : group.icon}
									customIcon={group.customIcon}
									className="group-icon"
								/>
							)}
							{group.name}
							{summary.breached && (
								<span className="group-breach-indicator" role="img" title="Contains breached passwords" aria-label="Contains breached passwords">
									<BreachWarningIcon className="breach-icon" />
								</span>
							)}
							{!summary.breached && (summary.weak || summary.breachedEmail) && (
								<span className="group-weak-password-indicator" role="img" title="Contains weak passwords or breached email addresses" aria-label="Contains weak passwords or breached email addresses">
									<SecurityShieldIcon className="weak-password-icon" />
								</span>
							)}
						</span>
					<span className="entry-count">
						{summary.entryCount}
					</span>
					<div className="group-actions" onClick={(e) => e.stopPropagation()}>
						<button
							className="group-action-button"
							onClick={() => onNewGroup(group)}
							title="Add subgroup" aria-label="Add subgroup"
						>
							<AddActionIcon />
						</button>
						{group.id !== database.root.id && (
							<button
								className="group-action-button"
								onClick={() => onEditGroup?.(group)}
								title="Edit group" aria-label="Edit group"
							>
								<EditActionIcon />
							</button>
						)}
						{group.id !== database.root.id && onMoveGroupRequest && (
							<button
								className="group-action-button"
								onClick={() => onMoveGroupRequest(group)}
								title="Move group" aria-label="Move group"
							>
								<MoveActionIcon />
							</button>
						)}
						{group.id !== database.root.id && (
							<button
								className="group-action-button"
								onClick={() => onRemoveGroup(group)}
								title="Remove group" aria-label="Remove group"
							>
								<CloseActionIcon />
							</button>
						)}
					</div>
				</div>
			</div>
			{isExpanded && hasSubgroups && (
				<div className="subgroups" role="group">
					{group.groups.map((subgroup) => (
						<GroupItem
							key={subgroup.id}
							group={subgroup}
							level={level + 1}
							selectedGroup={selectedGroup}
							groupSummaries={groupSummaries}
							onGroupSelect={onGroupSelect}
							onNewGroup={onNewGroup}
							onRemoveGroup={onRemoveGroup}
							onEditGroup={onEditGroup}
							onMoveGroup={onMoveGroup}
							onMoveEntry={onMoveEntry}
							onMoveGroupRequest={onMoveGroupRequest}
							database={database}
							collapsed={collapsed}
							onToggle={onToggle}
							tabbableId={tabbableId}
							onRowFocus={onRowFocus}
							onSelectId={onSelectId}
						/>
					))}
				</div>
			)}
		</div>
	);
};

// The groups from the root down to the one with this id, or null
const pathTo = (group: Group, id: string): Group[] | null => {
	if (group.id === id) return [group];
	for (const child of group.groups) {
		const rest = pathTo(child, id);
		if (rest) return [group, ...rest];
	}
	return null;
};

export const Sidebar = ({ database, selectedGroup, groupSummaries, onGroupSelect, onNewGroup, onRemoveGroup, onEditGroup, onMoveGroup, onMoveEntry, onDatabaseChange, onMoveGroupRequest, treeRef }: SidebarProps) => {
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [editedTitle, setEditedTitle] = useState(database.name);
	const titleInputRef = useRef<HTMLInputElement>(null);
	// Everything starts expanded; the set holds the exceptions
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const [focusedId, setFocusedId] = useState(selectedGroup.id);

	useEffect(() => {
		setFocusedId(selectedGroup.id);
	}, [selectedGroup.id]);

	const toggle = (groupId: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	};

	// The Tab stop is the focused row when it is on screen, else the root
	const focusedPath = pathTo(database.root, focusedId);
	const tabbableId = focusedPath && focusedPath.slice(0, -1).every((g) => !collapsed.has(g.id))
		? focusedId
		: database.root.id;

	const selectId = (groupId: string) => {
		const group = KeepassDatabaseService.findGroupInDatabase(groupId, database.root);
		if (group) onGroupSelect(group);
	};

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
			e.preventDefault();
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
						aria-label="Database name"
						value={editedTitle}
						onChange={(e) => setEditedTitle(e.target.value)}
						onBlur={handleTitleSubmit}
						onKeyDown={handleTitleKeyDown}
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<h2 className="database-title">
						<button
							type="button"
							className="database-title-button"
							onClick={() => {
								setEditedTitle(database.name);
								setIsEditingTitle(true);
							}}
							title="Rename database"
							aria-label={`${database.name}, rename database`}
						>
							{database.name}
							<EditActionIcon className="edit-icon" />
						</button>
					</h2>
				)}
			</div>
			<div className="groups-container" role="tree" aria-label="Groups" ref={treeRef}>
				<GroupItem
					group={database.root}
					level={0}
					selectedGroup={selectedGroup}
					groupSummaries={groupSummaries}
					onGroupSelect={onGroupSelect}
					onNewGroup={onNewGroup}
					onRemoveGroup={onRemoveGroup}
					onEditGroup={onEditGroup}
					onMoveGroup={onMoveGroup}
					onMoveEntry={onMoveEntry}
					onMoveGroupRequest={onMoveGroupRequest}
					database={database}
					collapsed={collapsed}
					onToggle={toggle}
					tabbableId={tabbableId}
					onRowFocus={setFocusedId}
					onSelectId={selectId}
				/>
			</div>
		</div>
	);
};
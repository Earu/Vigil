import { useState } from 'react';
import { Database, Group } from '../../types/database';

interface SidebarProps {
	database: Database;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
}

interface GroupItemProps {
	group: Group;
	level: number;
	selectedGroup: Group;
	onGroupSelect: (group: Group) => void;
}

const GroupItem = ({ group, level, selectedGroup, onGroupSelect }: GroupItemProps) => {
	const [isExpanded, setIsExpanded] = useState(true);
	const hasSubgroups = group.groups.length > 0;

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
				onClick={() => onGroupSelect(group)}
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
				<span className="group-name">{group.name}</span>
				<span className="entry-count">
					{getAllEntriesCount(group)}
				</span>
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
						/>
					))}
				</div>
			)}
		</div>
	);
};

export const Sidebar = ({ database, selectedGroup, onGroupSelect }: SidebarProps) => {
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
				/>
			</div>
		</div>
	);
};
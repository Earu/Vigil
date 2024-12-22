import { useState, useEffect } from 'react';
import { Database, Entry, Group } from '../../types/database';
import { Sidebar } from './Sidebar';
import { EntryList } from './EntryList';
import { EntryDetails } from './EntryDetails';
import './PasswordView.css';

interface PasswordViewProps {
  database: Database;
  onLock: () => void;
}

export const PasswordView = ({ database, onLock }: PasswordViewProps) => {
  const [selectedGroup, setSelectedGroup] = useState<Group>(database.root);
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Clear selected entry when changing groups or search query
  useEffect(() => {
    setSelectedEntry(null);
  }, [selectedGroup.id, searchQuery]);

  const handleGroupSelect = (group: Group) => {
    setSelectedGroup(group);
    setSearchQuery(''); // Clear search when changing groups
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  return (
    <div className="password-view">
      <div className="password-view-header">
        <div className="search-container">
          <input
            type="text"
            className="search-input"
            placeholder="Search passwords..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <button className="lock-button" onClick={onLock} title="Lock database">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="lock-icon"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Lock
        </button>
      </div>

      <div className="password-view-content">
        <Sidebar
          database={database}
          selectedGroup={selectedGroup}
          onGroupSelect={handleGroupSelect}
        />
        <EntryList
          group={selectedGroup}
          searchQuery={searchQuery}
          selectedEntry={selectedEntry}
          onEntrySelect={setSelectedEntry}
          database={database}
        />
        {selectedEntry && (
          <EntryDetails
            entry={selectedEntry}
            onClose={() => setSelectedEntry(null)}
          />
        )}
      </div>
    </div>
  );
};
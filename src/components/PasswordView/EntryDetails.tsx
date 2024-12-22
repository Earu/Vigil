import { useState } from 'react';
import { Entry } from '../../types/database';

interface EntryDetailsProps {
  entry: Entry;
  onClose: () => void;
}

export const EntryDetails = ({ entry, onClose }: EntryDetailsProps) => {
  const [showPassword, setShowPassword] = useState(false);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // TODO: Show a toast notification
      console.log(`${field} copied to clipboard`);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  const renderFieldValue = (value: string | undefined, placeholder = 'No data') => {
    return value?.trim() || placeholder;
  };

  return (
    <div className="entry-details">
      <div className="entry-details-header">
        <h2>{entry.title}</h2>
        <button className="close-button" onClick={onClose}>
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
      </div>

      <div className="entry-fields">
        <div className="field-group">
          <label>Username</label>
          <div className="field-value-container">
            <input
              type="text"
              readOnly
              value={renderFieldValue(entry.username)}
              className="field-value monospace"
            />
            <button
              className="copy-button"
              onClick={() => copyToClipboard(entry.username, 'Username')}
              title="Copy username"
              disabled={!entry.username}
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
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        </div>

        <div className="field-group">
          <label>Password</label>
          <div className="field-value-container">
            <input
              type={showPassword ? 'text' : 'password'}
              readOnly
              value={renderFieldValue(entry.password)}
              className="field-value monospace"
            />
            <button
              className="visibility-button"
              onClick={() => setShowPassword(!showPassword)}
              title={showPassword ? 'Hide password' : 'Show password'}
              disabled={!entry.password}
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
                {showPassword ? (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
            </button>
            <button
              className="copy-button"
              onClick={() => copyToClipboard(entry.password, 'Password')}
              title="Copy password"
              disabled={!entry.password}
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
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        </div>

        <div className="field-group">
          <label>URL</label>
          <div className="field-value-container">
            <input
              type="text"
              readOnly
              value={renderFieldValue(entry.url, 'No URL')}
              className="field-value"
            />
            <button
              className="copy-button"
              onClick={() => copyToClipboard(entry.url!, 'URL')}
              title="Copy URL"
              disabled={!entry.url}
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
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="open-button"
                title="Open URL"
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
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            )}
          </div>
        </div>

        <div className="field-group">
          <label>Notes</label>
          <textarea
            readOnly
            value={renderFieldValue(entry.notes, 'No notes')}
            className="field-value notes"
          />
        </div>

        <div className="field-group metadata">
          <div className="metadata-item">
            <label>Created</label>
            <span>{entry.created.toLocaleString()}</span>
          </div>
          <div className="metadata-item">
            <label>Modified</label>
            <span>{entry.modified.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
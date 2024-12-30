import { Database } from '../../types/database';
import { useState } from 'react';
import { BreachedEntry } from '../../services/BreachCheckService';
import { SpinnerIcon } from '../../icons/status/StatusIcons';
import { CloseActionIcon } from '../../icons/actions/ActionIcons';
import './BreachReport.css';

interface BreachReportProps {
    database: Database;
    onClose: () => void;
    breachedEntries: Array<BreachedEntry>;
    weakEntries: Array<BreachedEntry>;
    isChecking: boolean;
}

type TabType = 'breached' | 'weak';

const getStrengthColor = (score: number) => {
    switch (score) {
        case 0: return '#dc2626'; // red-600
        case 1: return '#dc2626'; // red-600
        case 2: return '#f59e0b'; // amber-500
        case 3: return '#10b981'; // emerald-500
        case 4: return '#10b981'; // emerald-500
        default: return '#94a3b8'; // gray-400
    }
};

const getStrengthLabel = (score: number) => {
    switch (score) {
        case 0: return 'Very Weak';
        case 1: return 'Weak';
        case 2: return 'Fair';
        case 3: return 'Strong';
        case 4: return 'Very Strong';
        default: return 'Unknown';
    }
};

export const BreachReport = ({ breachedEntries, weakEntries, onClose, isChecking }: BreachReportProps) => {
    const [activeTab, setActiveTab] = useState<TabType>('breached');
    const hasWeakPasswords = weakEntries.length > 0;
    const hasBreachedPasswords = breachedEntries.length > 0;

    const renderBreachedEntry = ({ entry, group, count }: BreachedEntry) => (
        <div key={entry.id} className="breached-entry">
            <div className="entry-info">
                <h3>{entry.title}</h3>
                <p className="username">{entry.username}</p>
                <p className="group-path">Group: {group.name}</p>
            </div>
            <div className="breach-info">
                <span className="breach-count">
                    Found in {count.toLocaleString()} {count === 1 ? 'breach' : 'breaches'}
                </span>
            </div>
        </div>
    );

    const renderWeakEntry = ({ entry, group, strength }: BreachedEntry) => (
        <div key={entry.id} className="breached-entry">
            <div className="entry-info">
                <h3>{entry.title}</h3>
                <p className="username">{entry.username}</p>
                <p className="group-path">Group: {group.name}</p>
            </div>
            <div className="breach-info">
                {strength && (
                    <span
                        className="strength-indicator"
                        style={{ color: getStrengthColor(strength.score) }}
                    >
                        {getStrengthLabel(strength.score)}
                    </span>
                )}
            </div>
        </div>
    );

    return (
        <div className="breach-report-overlay">
            <div className="breach-report">
                <div className="breach-report-header">
                    <h2>Security Report</h2>
                    <button className="close-button" onClick={onClose}>
                        <CloseActionIcon />
                    </button>
                </div>
                <div className="breach-report-tabs">
                    <button
                        className={`tab-button ${activeTab === 'breached' ? 'active' : ''}`}
                        onClick={() => setActiveTab('breached')}
                    >
                        Compromised ({breachedEntries.length})
                    </button>
                    <button
                        className={`tab-button ${activeTab === 'weak' ? 'active' : ''}`}
                        onClick={() => setActiveTab('weak')}
                    >
                        Weak ({weakEntries.length})
                    </button>
                </div>
                <div className="breach-report-content">
                    {isChecking && (
                        <div className="breach-summary">
                            <div className="breach-count">
                                <SpinnerIcon className="spinner" />
                            </div>
                            <p className="breach-warning">
                                Checking passwords for breaches...
                            </p>
                        </div>
                    )}

                    {!isChecking && activeTab === 'breached' && hasBreachedPasswords && (
                        <>
                            <div className="breach-summary">
                                <div className="breach-count">
                                    <span className="count">{breachedEntries.length}</span>
                                    <span className="label">Compromised {breachedEntries.length === 1 ? 'Password' : 'Passwords'}</span>
                                </div>
                                <p className="breach-warning">
                                    These passwords have appeared in known data breaches. It's recommended to change them as soon as possible.
                                </p>
                            </div>
                            <div className="breached-entries">
                                {breachedEntries.map(entry => renderBreachedEntry(entry))}
                            </div>
                        </>
                    )}

                    {!isChecking && activeTab === 'weak' && hasWeakPasswords && (
                        <>
                            <div className="weak-passwords-summary">
                                <div className="weak-count">
                                    <span className="count">{weakEntries.length}</span>
                                    <span className="label">Weak {weakEntries.length === 1 ? 'Password' : 'Passwords'}</span>
                                </div>
                                <p className="weak-warning">
                                    These passwords are considered weak and should be strengthened to improve security.
                                </p>
                            </div>
                            <div className="breached-entries">
                                {weakEntries.map(entry => renderWeakEntry(entry))}
                            </div>
                        </>
                    )}

                    {!isChecking && ((activeTab === 'breached' && !hasBreachedPasswords) ||
                      (activeTab === 'weak' && !hasWeakPasswords)) && (
                        <div className="breach-summary">
                            <p className="breach-warning">
                                No {activeTab === 'breached' ? 'compromised' : 'weak'} passwords found.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
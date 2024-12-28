import { Database, Entry, Group } from '../../types/database';
import './BreachReport.css';

interface BreachReportProps {
    database: Database;
    onClose: () => void;
    breachedEntries: Array<{
        entry: Entry;
        group: Group;
        count: number;
        strength?: {
            score: number;
            feedback: {
                warning: string;
                suggestions: string[];
            };
        };
    }>;
}

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

export const BreachReport = ({ breachedEntries, onClose }: BreachReportProps) => {
    const weakPasswords = breachedEntries.filter(entry => entry.strength && entry.strength.score < 3);
    const hasWeakPasswords = weakPasswords.length > 0;

    return (
        <div className="breach-report-overlay">
            <div className="breach-report">
                <div className="breach-report-header">
                    <h2>Security Report</h2>
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
                <div className="breach-report-content">
                    <div className="breach-summary">
                        <div className="breach-count">
                            <span className="count">{breachedEntries.length}</span>
                            <span className="label">Compromised {breachedEntries.length === 1 ? 'Password' : 'Passwords'}</span>
                        </div>
                        <p className="breach-warning">
                            These passwords have appeared in known data breaches. It's recommended to change them as soon as possible.
                        </p>
                    </div>

                    {hasWeakPasswords && (
                        <div className="weak-passwords-summary">
                            <div className="weak-count">
                                <span className="count">{weakPasswords.length}</span>
                                <span className="label">Weak {weakPasswords.length === 1 ? 'Password' : 'Passwords'}</span>
                            </div>
                            <p className="weak-warning">
                                Some passwords are considered weak and should be strengthened to improve security.
                            </p>
                        </div>
                    )}

                    <div className="breached-entries">
                        {breachedEntries.map(({ entry, group, count, strength }) => (
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
                        ))}
                    </div>
                </div>
                <div className="breach-report-footer">
                    <button className="primary-button" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};
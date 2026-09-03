import { Database, Entry, Group } from '../../types/database';
import { useState } from 'react';
import { BreachedEntry, BreachedEmailEntry, ReusedPasswordGroup } from '../../services/BreachCheckService';
import { VirtualList } from './VirtualList';
import { SpinnerIcon } from '../../icons/status/StatusIcons';
import { CloseActionIcon } from '../../icons/actions/ActionIcons';
import './BreachReport.css';

interface BreachReportProps {
    database: Database;
    onClose: () => void;
    breachedEntries: Array<BreachedEntry>;
    weakEntries: Array<BreachedEntry>;
    breachedEmailEntries: Array<BreachedEmailEntry>;
    // Clusters of entries sharing one password, widest reuse first
    reusedPasswords: Array<ReusedPasswordGroup>;
    // Entries involved in any cluster, which is what the tab counts
    reusedEntryCount: number;
    expiredEntries: Array<{ entry: Entry; group: Group }>;
    isChecking: boolean;
    isCheckingEmails: boolean;
}

type TabType = 'breached' | 'reused' | 'weak' | 'emails' | 'expired';

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

export const BreachReport = ({
    breachedEntries,
    weakEntries,
    breachedEmailEntries,
    reusedPasswords,
    reusedEntryCount,
    expiredEntries,
    onClose,
    isChecking,
    isCheckingEmails
}: BreachReportProps) => {
    const [activeTab, setActiveTab] = useState<TabType>('breached');
    const hasWeakPasswords = weakEntries.length > 0;
    const hasBreachedPasswords = breachedEntries.length > 0;
    const hasBreachedEmails = breachedEmailEntries.length > 0;
    const hasReusedPasswords = reusedPasswords.length > 0;
    const hasExpiredEntries = expiredEntries.length > 0;
    // Reuse and expiry are read straight off the model, so those tabs have
    // nothing to wait for; only the HIBP-backed ones show the spinner
    const waiting = (isChecking || isCheckingEmails) &&
        (activeTab === 'breached' || activeTab === 'weak' || activeTab === 'emails');

    const renderBreachedEntry = ({ entry, group, count }: BreachedEntry) => (
        <div key={entry.id} className="breached-entry">
            <div className="report-entry-info">
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
            <div className="report-entry-info">
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

    const renderEmailEntry = (entry: BreachedEmailEntry) => (
        <div key={entry.entry.id} className="breached-entry">
            <div className="report-entry-info">
                <h3>{entry.entry.title}</h3>
                <p className="username">{entry.entry.username}</p>
                <p className="group-path">Group: {entry.group.name}</p>
            </div>
            <div className="breach-info">
                <span className="strength-indicator" style={{ color: getStrengthColor(2) }}>
                    Found in {entry.breaches.length} {entry.breaches.length === 1 ? 'breach' : 'breaches'}
                </span>
            </div>
        </div>
    );

    const renderReusedCluster = (cluster: ReusedPasswordGroup) => (
        <div key={cluster.entries[0].entry.id} className="reused-cluster">
            <div className="reused-cluster-header">
                Shared by {cluster.count} entries
            </div>
            <div className="breached-entries">
                {cluster.entries.map(({ entry, group }) => (
                    <div key={entry.id} className="breached-entry">
                        <div className="report-entry-info">
                            <h3>{entry.title}</h3>
                            <p className="username">{entry.username}</p>
                            <p className="group-path">Group: {group.name}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderExpiredEntry = ({ entry, group }: { entry: Entry; group: Group }) => (
        <div key={entry.id} className="breached-entry">
            <div className="report-entry-info">
                <h3>{entry.title}</h3>
                <p className="username">{entry.username}</p>
                <p className="group-path">Group: {group.name}</p>
            </div>
            <div className="breach-info">
                <span className="strength-indicator" style={{ color: getStrengthColor(0) }}>
                    Expired {entry.expiryTime?.toLocaleDateString()}
                </span>
            </div>
        </div>
    );

    return (
        <div className="breach-report-overlay">
            <div className="breach-report">
                <div className="breach-report-header">
                    <h2>Security Report</h2>
                    <button className="report-close-button" onClick={onClose}>
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
                        className={`tab-button ${activeTab === 'reused' ? 'active' : ''}`}
                        onClick={() => setActiveTab('reused')}
                    >
                        Reused ({reusedEntryCount})
                    </button>
                    <button
                        className={`tab-button ${activeTab === 'weak' ? 'active' : ''}`}
                        onClick={() => setActiveTab('weak')}
                    >
                        Weak ({weakEntries.length})
                    </button>
                    <button
                        className={`tab-button ${activeTab === 'emails' ? 'active' : ''}`}
                        onClick={() => setActiveTab('emails')}
                    >
                        Exposed ({breachedEmailEntries.length})
                    </button>
                    <button
                        className={`tab-button ${activeTab === 'expired' ? 'active' : ''}`}
                        onClick={() => setActiveTab('expired')}
                    >
                        Expired ({expiredEntries.length})
                    </button>
                </div>
                <div className="breach-report-content">
                    {waiting && (
                        <div className="breach-summary neutral">
                            <div className="breach-count">
                                <SpinnerIcon className="spinner" />
                            </div>
                            <p className="breach-warning">
                                {isChecking ? 'Checking passwords for breaches...' : 'Checking emails for breaches...'}
                            </p>
                        </div>
                    )}

                    {!waiting && activeTab === 'breached' && hasBreachedPasswords && (
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
                            <VirtualList
                                className="breached-entries"
                                items={breachedEntries}
                                renderItem={renderBreachedEntry}
                            />
                        </>
                    )}

                    {!waiting && activeTab === 'weak' && hasWeakPasswords && (
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
                            <VirtualList
                                className="breached-entries"
                                items={weakEntries}
                                renderItem={renderWeakEntry}
                            />
                        </>
                    )}

                    {!waiting && activeTab === 'emails' && hasBreachedEmails && (
                        <>
                            <div className="weak-passwords-summary">
                                <div className="weak-count">
                                    <span className="count">{breachedEmailEntries.length}</span>
                                    <span className="label">Exposed {breachedEmailEntries.length === 1 ? 'Account' : 'Accounts'}</span>
                                </div>
                                <p className="weak-warning">
                                    These accounts have email addresses that have been exposed in data breaches since their passwords were last changed. It's recommended to update their passwords to ensure account security.
                                </p>
                            </div>
                            <VirtualList
                                className="breached-entries"
                                items={breachedEmailEntries}
                                renderItem={renderEmailEntry}
                            />
                        </>
                    )}

                    {!waiting && activeTab === 'reused' && hasReusedPasswords && (
                        <>
                            <div className="weak-passwords-summary">
                                <div className="weak-count">
                                    <span className="count">{reusedEntryCount}</span>
                                    <span className="label">Reused {reusedEntryCount === 1 ? 'Password' : 'Passwords'}</span>
                                </div>
                                <p className="weak-warning">
                                    These entries share a password with at least one other entry. One breach then exposes every account in the group, so give each of them its own password.
                                </p>
                            </div>
                            <VirtualList
                                className="reused-clusters"
                                items={reusedPasswords}
                                renderItem={renderReusedCluster}
                                itemUnits={cluster => cluster.entries.length}
                                unitSelector=".breached-entry"
                            />
                        </>
                    )}

                    {!waiting && activeTab === 'expired' && hasExpiredEntries && (
                        <>
                            <div className="weak-passwords-summary">
                                <div className="weak-count">
                                    <span className="count">{expiredEntries.length}</span>
                                    <span className="label">Expired {expiredEntries.length === 1 ? 'Entry' : 'Entries'}</span>
                                </div>
                                <p className="weak-warning">
                                    These entries are past their expiry date. Rotate the credentials and set a new expiry.
                                </p>
                            </div>
                            <VirtualList
                                className="breached-entries"
                                items={expiredEntries}
                                renderItem={renderExpiredEntry}
                            />
                        </>
                    )}

                    {!waiting && ((activeTab === 'breached' && !hasBreachedPasswords) ||
                      (activeTab === 'reused' && !hasReusedPasswords) ||
                      (activeTab === 'weak' && !hasWeakPasswords) ||
                      (activeTab === 'emails' && !hasBreachedEmails) ||
                      (activeTab === 'expired' && !hasExpiredEntries)) && (
                        <div className="breach-summary neutral">
                            <p className="breach-warning">
                                No {activeTab === 'breached' ? 'compromised passwords' :
                                   activeTab === 'reused' ? 'reused passwords' :
                                   activeTab === 'weak' ? 'weak passwords' :
                                   activeTab === 'emails' ? 'exposed emails' :
                                   'expired entries'} found.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
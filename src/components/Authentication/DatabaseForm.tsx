import { BrowseAuthIcon, ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { useState } from 'react';

interface DatabaseFormProps {
    setSelectedFile: (file: File | null) => void;
    setDatabasePath: (path: string | null) => void;
    setIsCreatingNew: (isCreating: boolean) => void;
    setError: (error: string | null) => void;
    setBrowserPasswords: (passwords: Array<{ url: string; username: string; password: string }>) => void;
}

export const DatabaseForm = ({
    setSelectedFile,
    setDatabasePath,
    setIsCreatingNew,
    setError,
    setBrowserPasswords
}: DatabaseFormProps) => {
    const [showBrowserSelect, setShowBrowserSelect] = useState(false);
    const [selectedBrowsers, setSelectedBrowsers] = useState<{ [key: string]: boolean }>({
        chrome: false,
        edge: false,
        brave: false,
        vivaldi: false,
        opera: false,
        chromium: false
    });

    const browsers = [
        { id: 'chrome', name: 'Google Chrome' },
        { id: 'edge', name: 'Microsoft Edge' },
        { id: 'brave', name: 'Brave Browser' },
        { id: 'vivaldi', name: 'Vivaldi' },
        { id: 'opera', name: 'Opera' },
        { id: 'chromium', name: 'Chromium' }
    ];

    const handleFileSelect = async (e: React.MouseEvent) => {
        e.preventDefault();
        if (!window.electron) return;

        const result = await window.electron.openFile();
        if (result.canceled || !result.filePath) return;

        try {
            const fileResult = await window.electron.readFile(result.filePath);
            if (!fileResult.success || !fileResult.data) {
                throw new Error(fileResult.error || 'Failed to read file');
            }

            setSelectedFile(new File([fileResult.data], result.filePath.split('/').pop() || 'database.kdbx'));
            setDatabasePath(result.filePath);
            setError(null);
        } catch (err) {
            console.error('Failed to read file:', err);
            setError('Failed to read file');
        }
    };

    const handleBrowserImport = async () => {
        const selectedBrowserIds = Object.entries(selectedBrowsers)
            .filter(([_, isSelected]) => isSelected)
            .map(([id]) => id);

        if (selectedBrowserIds.length === 0) {
            setError('Please select at least one browser');
            return;
        }

        setShowBrowserSelect(false);
        setIsCreatingNew(true);

        window.electron?.importBrowserPasswords(selectedBrowserIds)
            .then(passwords => {
                setBrowserPasswords(passwords?.passwords || []);
            })
            .catch(err => {
                console.error('Failed to import browser passwords:', err);
                setError('Failed to import browser passwords');
            });
    };

    const toggleBrowser = (browserId: string) => {
        setSelectedBrowsers(prev => ({
            ...prev,
            [browserId]: !prev[browserId]
        }));
    };

    return (
        <>
            <p>Select or drop your KeePass database file to get started</p>
            <div className="database-actions">
                <button
                    className="file-input-label"
                    onClick={handleFileSelect}
                >
                    <BrowseAuthIcon className="browse-icon" />
                    Browse Database
                </button>
                <button
                    className="create-new-button"
                    onClick={() => setIsCreatingNew(true)}
                >
                    Create New Database
                </button>
                <button
                    className="import-browser-button"
                    onClick={() => setShowBrowserSelect(true)}
                >
                    <ImportAuthIcon className="import-icon" />
                    Import from my browser
                </button>
            </div>
            {showBrowserSelect && (
                <div className="browser-select-overlay">
                    <div className="browser-select-modal">
                        <div className="modal-header">
                            <h3>Import Browser Passwords</h3>
                            <button
                                className="close-button"
                                onClick={() => setShowBrowserSelect(false)}
                            >
                                ×
                            </button>
                        </div>
                        <div className="modal-content">
                            <p>Select the browsers you want to import passwords from:</p>
                            <div className="browser-toggles">
                                {browsers.map(browser => (
                                    <label key={browser.id} className="browser-toggle">
                                        <input
                                            type="checkbox"
                                            checked={selectedBrowsers[browser.id]}
                                            onChange={() => toggleBrowser(browser.id)}
                                        />
                                        <span className="toggle-label">{browser.name}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button
                                className="secondary-button"
                                onClick={() => setShowBrowserSelect(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="primary-button"
                                onClick={handleBrowserImport}
                            >
                                Import Selected
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
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
    const [showImportModal, setShowImportModal] = useState(false);

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

    const handleCsvImport = async () => {
        // Create a file input element
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const lines = text.split(/\r?\n/).filter(line => line.trim());

                if (lines.length === 0) {
                    throw new Error('CSV file is empty');
                }

                const passwords: Array<{ url: string; username: string; password: string }> = [];
                const headerLine = parseCSVLine(lines[0]);
                const headers = headerLine.map(h => h.toLowerCase());

                const urlIndex = headers.findIndex(h => h === 'url' || h === 'origin');
                const usernameIndex = headers.findIndex(h => h === 'username' || h === 'username field' || h === 'usernamevalue');
                const passwordIndex = headers.findIndex(h => h === 'password' || h === 'password field' || h === 'passwordvalue');

                if (passwordIndex === -1 || (urlIndex === -1 && usernameIndex === -1)) {
                    console.log('Could not find required columns. Headers found:', headers);
                    throw new Error('Could not find required columns (url/origin, username, password) in the CSV file');
                }

                // Parse based on known CSV formats
                for (let i = 1; i < lines.length; i++) {
                    const values = parseCSVLine(lines[i]);
                    if (values.length === 0) {
                        console.log(`Skipping empty line ${i + 1}`);
                        continue;
                    }

                    const url = urlIndex !== -1 ? values[urlIndex] : "";
                    const username = usernameIndex !== -1 ? values[usernameIndex] : "";
                    const password = values[passwordIndex];

                    if (!password) {
                        continue;
                    }

                    passwords.push({ url, username, password });
                }

                if (passwords.length === 0) {
                    throw new Error('No valid password entries found in CSV');
                }

                console.log(`Successfully imported ${passwords.length} passwords from CSV (${lines.length - 1} total entries)`);
                setShowImportModal(false);
                setIsCreatingNew(true);
                setBrowserPasswords(passwords);
            } catch (err) {
                console.error('Failed to import CSV:', err);
                setError(err instanceof Error ? err.message : 'Failed to import CSV file');
            }
        };

        // Trigger the file picker
        input.click();
    };

    // Helper function to parse CSV lines properly handling quoted fields
    const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    // Handle escaped quotes
                    current += '"';
                    i++;
                } else {
                    // Toggle quote state
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                // End of field
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }

        // Add the last field
        result.push(current.trim());
        return result;
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
                    onClick={() => setShowImportModal(true)}
                >
                    <ImportAuthIcon className="import-icon" />
                    Import from CSV
                </button>
            </div>
            {showImportModal && (
                <div className="browser-select-overlay">
                    <div className="browser-select-modal">
                        <div className="modal-header">
                            <h3>Import Passwords from CSV</h3>
                            <button
                                className="close-button"
                                onClick={() => setShowImportModal(false)}
                            >
                                ×
                            </button>
                        </div>
                        <div className="modal-content">
                            <p>Select a CSV file containing your exported passwords.</p>
                            <p className="help-text">
                                The CSV file should contain columns for URL, username, and password.
                                You can export these from your browser's password manager.
                            </p>
                        </div>
                        <div className="modal-footer">
                            <button
                                className="secondary-button"
                                onClick={() => setShowImportModal(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="primary-button"
                                onClick={handleCsvImport}
                            >
                                Select CSV File
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
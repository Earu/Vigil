import { BrowseAuthIcon, ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { useState } from 'react';
import { CsvImportService } from '../../services/CsvImportService';

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
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const passwords = await CsvImportService.importFromCsv(file);
                setBrowserPasswords(passwords);
                setShowImportModal(false);
                setIsCreatingNew(true);
            } catch (err) {
                console.error('Failed to import CSV:', err);
                setError(err instanceof Error ? err.message : 'Failed to import CSV file');
            }
        };

        input.click();
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
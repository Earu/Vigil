import { BrowseAuthIcon, ImportAuthIcon } from '../../icons/auth/AuthIcons';
import { useState } from 'react';
import { ImportService, ImportResult } from '../../services/ImportService';
import { Modal } from '../Modal';

interface DatabaseFormProps {
    setSelectedFile: (file: File | null) => void;
    setDatabasePath: (path: string | null) => void;
    setIsCreatingNew: (isCreating: boolean) => void;
    setError: (error: string | null) => void;
    setBrowserPasswords: (passwords: ImportResult) => void;
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
            setError(err instanceof Error && err.message ? err.message : 'Failed to read file');
        }
    };

    const handleCsvImport = async () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,.json';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const result = await ImportService.parseFile(file);
                setBrowserPasswords(result);
                setShowImportModal(false);
                setIsCreatingNew(true);
            } catch (err) {
                console.error('Failed to import:', err);
                setError(err instanceof Error ? err.message : 'Failed to import file');
            }
        };

        input.click();
    };

    return (
        <>
            <p>Select or drop your KeePass database file</p>
            <div className="database-actions">
                <button
                    className="file-input-label"
                    onClick={handleFileSelect}
                >
                    <BrowseAuthIcon className="browse-icon" />
                    Browse Database
                </button>
                <button
                    className="secondary-button"
                    onClick={() => setIsCreatingNew(true)}
                >
                    Create New Database
                </button>
                <button
                    className="secondary-button"
                    onClick={() => setShowImportModal(true)}
                >
                    <ImportAuthIcon className="auth-import-icon" />
                    Import passwords
                </button>
            </div>
            {showImportModal && (
                <Modal overlayClassName="browser-select-overlay" className="browser-select-modal" labelledBy="auth-import-title" onClose={() => setShowImportModal(false)}>
                        <div className="auth-modal-header">
                            <h3 id="auth-import-title">Import Passwords</h3>
                            <button
                                className="auth-close-button"
                                onClick={() => setShowImportModal(false)}
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="modal-content">
                            <p>Select an export from your previous password manager.</p>
                            <p className="help-text">
                                Bitwarden (.json or .csv), LastPass, 1Password, and browser CSV exports
                                are detected automatically.
                            </p>
                        </div>
                        <div className="auth-modal-footer">
                            <button
                                className="secondary-button"
                                onClick={() => setShowImportModal(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="auth-primary-button"
                                onClick={handleCsvImport}
                            >
                                Select File
                            </button>
                        </div>
                </Modal>
            )}
        </>
    );
};
interface DatabaseFormProps {
    setSelectedFile: (file: File | null) => void;
    setDatabasePath: (path: string | null) => void;
    setIsCreatingNew: (isCreating: boolean) => void;
    setError: (error: string | null) => void;
}

export const DatabaseForm = ({
    setSelectedFile,
    setDatabasePath,
    setIsCreatingNew,
    setError
}: DatabaseFormProps) => {
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

    return (
        <>
            <p>Select or drop your KeePass database file to get started</p>
            <div className="database-actions">
                <button
                    className="file-input-label"
                    onClick={handleFileSelect}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="browse-icon"
                    >
                        <path d="M20 11.08V8l-6-6H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2v-3.08" />
                        <path d="M14 3v5h5M18 21v-6M15 18h6" />
                    </svg>
                    Browse Database
                </button>
                <button
                    className="create-new-button"
                    onClick={() => setIsCreatingNew(true)}
                >
                    Create New Database
                </button>
            </div>
        </>
    );
}; 
import { BrowseAuthIcon, ImportAuthIcon } from '../../icons/auth/AuthIcons';

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
                    onClick={() => {
                        setIsCreatingNew(true);
                        window.electron?.importBrowserPasswords(['chrome', 'firefox', 'edge'])
                            .then(passwords => {
                                setBrowserPasswords(passwords?.passwords || []);
                            })
                            .catch(err => {
                                console.error('Failed to import browser passwords:', err);
                                setError('Failed to import browser passwords');
                            });
                    }}
                >
                    <ImportAuthIcon className="import-icon" />
                    Import from my browser
                </button>
            </div>
        </>
    );
};
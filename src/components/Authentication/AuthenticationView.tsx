import { useState, useRef, useEffect } from 'react';
import { DatabaseForm } from './DatabaseForm';
import { PasswordForm } from './PasswordForm';
import { Database } from '../../types/database';
import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { LockAuthIcon, UploadAuthIcon } from '../../icons/auth/AuthIcons';
import './AuthenticationView.css';

interface AuthenticationViewProps {
    onDatabaseOpen: (database: Database, kdbxDb: kdbxweb.Kdbx, showBreachReport?: boolean) => void;
}

function triggerBiometricUnlock() {
    const passwordForm = document.querySelector('.password-form') as HTMLElement;
    if (passwordForm) {
        const biometricButton = passwordForm.querySelector('.biometric-unlock-button') as HTMLElement;
        if (biometricButton) {
            biometricButton.click();
        }
    }
}

export const AuthenticationView = ({ onDatabaseOpen }: AuthenticationViewProps) => {
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isCreatingNew, setIsCreatingNew] = useState(false);
    const [databasePath, setDatabasePath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [initialBiometricsEnabled, setInitialBiometricsEnabled] = useState(false);
    const passwordInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let hasDirectFileOpen = false;

        if (window.electron) {
            const handleFileOpened = async (data: { data: Buffer, path: string }) => {
                try {
                    setSelectedFile(new File([data.data], data.path.split('/').pop() || 'database.kdbx'));
                    setDatabasePath(data.path);
                    setError(null);
                    hasDirectFileOpen = true;

                    if (await KeepassDatabaseService.checkBiometricsForFile(data.path)) {
                        setInitialBiometricsEnabled(true);
                        setTimeout(() => triggerBiometricUnlock(), 100);
                    }
                } catch (err) {
                    setError('Failed to open file');
                }
            };

            window.electron.on('file-opened', handleFileOpened);

            // Load last database only if no direct file open
            const loadLastDatabase = async () => {
                if (hasDirectFileOpen) return;

                const result = await KeepassDatabaseService.loadLastDatabase();
                if (result.file && !hasDirectFileOpen) {
                    setSelectedFile(result.file);
                    setDatabasePath(result.databasePath);
                    setInitialBiometricsEnabled(result.biometricsEnabled);

                    if (result.biometricsEnabled) {
                        setTimeout(() => triggerBiometricUnlock(), 100);
                    }
                }
            };

            loadLastDatabase();

            return () => {
                if (!window.electron) return;
                window.electron.off('file-opened', handleFileOpened);
            };
        }
    }, []);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            setSelectedFile(file);
            setError(null);

            if (window.electron) {
                const fullPath = await window.electron.getFilePath(file.name);
                if (fullPath) {
                    setDatabasePath(fullPath);
                    const biometricsEnabled = await KeepassDatabaseService.checkBiometricsForFile(fullPath);
                    setInitialBiometricsEnabled(biometricsEnabled);
                }
            }
        }
    };

    return (
        <div
            className="authentication-view"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragLeave={handleDragLeave}
        >
            <div className="main-content">
                <div className="database-form">
                    <div className="form-icon">
                        <LockAuthIcon className="lock-icon" />
                    </div>
                    <h1>{isCreatingNew ? 'Create Database' : 'Open Database'}</h1>

                    {selectedFile || isCreatingNew ? (
                        <PasswordForm
                            selectedFile={selectedFile}
                            isCreatingNew={isCreatingNew}
                            databasePath={databasePath}
                            error={error}
                            setError={setError}
                            setSelectedFile={setSelectedFile}
                            onDatabaseOpen={onDatabaseOpen}
                            passwordInputRef={passwordInputRef}
                            setIsCreatingNew={setIsCreatingNew}
                            initialBiometricsEnabled={initialBiometricsEnabled}
                        />
                    ) : (
                        <DatabaseForm
                            setSelectedFile={setSelectedFile}
                            setDatabasePath={setDatabasePath}
                            setIsCreatingNew={setIsCreatingNew}
                            setError={setError}
                        />
                    )}
                </div>
            </div>

            {isDragging && (
                <div className={`drop-overlay ${isDragging ? 'visible' : ''}`}>
                    <div className="drop-message">
                        <UploadAuthIcon className="upload-icon" />
                        <span>Drop your database file here</span>
                    </div>
                </div>
            )}
        </div>
    );
};
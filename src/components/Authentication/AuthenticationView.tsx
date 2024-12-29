import { useState, useRef, useEffect } from 'react';
import { DatabaseForm } from './DatabaseForm';
import { PasswordForm } from './PasswordForm';
import { Database } from '../../types/database';
import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import './AuthenticationView.css';

interface AuthenticationViewProps {
    onDatabaseOpen: (database: Database, kdbxDb: kdbxweb.Kdbx, showBreachReport?: boolean) => void;
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
        const loadLastDatabase = async () => {
            const result = await KeepassDatabaseService.loadLastDatabase();
            if (result.file) {
                setSelectedFile(result.file);
                setDatabasePath(result.databasePath);
                setInitialBiometricsEnabled(result.biometricsEnabled);

                if (result.biometricsEnabled) {
                    setTimeout(() => {
                        const passwordForm = document.querySelector('.password-form') as HTMLElement;
                        if (passwordForm) {
                            const biometricButton = passwordForm.querySelector('.biometric-unlock-button') as HTMLElement;
                            if (biometricButton) {
                                biometricButton.click();
                            }
                        }
                    }, 100);
                }
            }
        };

        loadLastDatabase();
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
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="lock-icon"
                        >
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
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
                        <svg
                            className="upload-icon"
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <span>Drop your database file here</span>
                    </div>
                </div>
            )}
        </div>
    );
};
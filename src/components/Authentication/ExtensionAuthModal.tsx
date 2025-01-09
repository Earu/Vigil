import React, { useState } from 'react';
import { LockAuthIcon } from '../../icons/auth/AuthIcons';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import './ExtensionAuthModal.css';

interface ExtensionAuthModalProps {
    onAllow: (password?: string) => void;
    onDisallow: () => void;
    hasBiometrics: boolean;
}

export const ExtensionAuthModal: React.FC<ExtensionAuthModalProps> = ({
    onAllow,
    onDisallow,
    hasBiometrics
}) => {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isAuthenticating, setIsAuthenticating] = useState(false);

    const handleAllow = async () => {
        if (isAuthenticating) return;

        if (hasBiometrics) {
            setIsAuthenticating(true);
            try {
                const dbPath = KeepassDatabaseService.getPath();
                if (!dbPath) {
                    setError('Database path not found');
                    return;
                }

                const result = await window.electron?.getBiometricPassword(dbPath);
                if (result?.success && result.password) {
                    onAllow(result.password);
                } else {
                    setError('Biometric authentication failed');
                }
            } catch (error) {
                setError('Biometric authentication failed');
            } finally {
                setIsAuthenticating(false);
            }
        } else {
            if (!password) {
                setError('Password is required');
                return;
            }
            onAllow(password);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !isAuthenticating) {
            handleAllow();
        }
    };

    return (
        <div className="modal-overlay">
            <div className="extension-auth-modal">
                <div className="modal-icon">
                    <LockAuthIcon className="lock-icon" />
                </div>

                <h2>Extension Access Request</h2>
                <p>The browser extension wants to access your password database.</p>

                {!hasBiometrics && (
                    <div className="password-input-container">
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => {
                                setPassword(e.target.value);
                                setError(null);
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder="Enter your database password"
                            className={error ? 'error' : ''}
                            autoFocus
                        />
                        {error && <div className="error-message">{error}</div>}
                    </div>
                )}

                {hasBiometrics && error && (
                    <div className="error-message biometric-error">{error}</div>
                )}

                <div className="modal-buttons">
                    <button
                        className="disallow-button"
                        onClick={onDisallow}
                        disabled={isAuthenticating}
                    >
                        Disallow
                    </button>
                    <button
                        className="allow-button"
                        onClick={handleAllow}
                        disabled={isAuthenticating}
                    >
                        {isAuthenticating ? 'Authenticating...' : 'Allow'}
                    </button>
                </div>
            </div>
        </div>
    );
};
import { useState, useEffect } from 'react';
import './PasswordGenerator.css';
import * as kdbxweb from 'kdbxweb';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';

interface PasswordGeneratorProps {
    onClose: () => void;
    onSave: (password: kdbxweb.ProtectedValue) => void;
    currentPassword?: string;
}

interface PasswordOptions {
    length: number;
    upperCase: boolean;
    lowerCase: boolean;
    digits: boolean;
    special: boolean;
    brackets: boolean;
    space: boolean;
    minus: boolean;
    underline: boolean;
    latin1: boolean;
    customChars: string;
}

export const PasswordGenerator = ({ onClose, onSave, currentPassword }: PasswordGeneratorProps) => {
    const [generatedPassword, setGeneratedPassword] = useState('');
    const [options, setOptions] = useState<PasswordOptions>(() => {
        const defaultOptions = {
            length: 20,
            upperCase: true,
            lowerCase: true,
            digits: true,
            special: true,
            brackets: false,
            space: false,
            minus: false,
            underline: false,
            latin1: false,
            customChars: '',
        };

        if (!currentPassword) return defaultOptions;

        // Analyze current password to determine used character sets
        const hasUpperCase = /[A-Z]/.test(currentPassword);
        const hasLowerCase = /[a-z]/.test(currentPassword);
        const hasDigits = /[0-9]/.test(currentPassword);
        const hasSpecial = /[!@#$%^&*()_+=\[\]{}|;:,.<>?]/.test(currentPassword);
        const hasBrackets = /[\[\]{}()]/.test(currentPassword);
        const hasSpace = /\s/.test(currentPassword);
        const hasMinus = /-/.test(currentPassword);
        const hasUnderline = /_/.test(currentPassword);
        const hasLatin1 = /[À-ÿ]/.test(currentPassword);

        return {
            length: currentPassword.length,
            upperCase: hasUpperCase,
            lowerCase: hasLowerCase,
            digits: hasDigits,
            special: hasSpecial,
            brackets: hasBrackets,
            space: hasSpace,
            minus: hasMinus,
            underline: hasUnderline,
            latin1: hasLatin1,
            customChars: '',
        };
    });

    useEffect(() => {
        // Generate initial password when component mounts
        generatePassword();
    }, []); // Empty dependency array means this runs once on mount

    const [passwordStrength, setPasswordStrength] = useState<{
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    } | null>(null);

    const generateCharacterPool = () => {
        let chars = '';
        if (options.upperCase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (options.lowerCase) chars += 'abcdefghijklmnopqrstuvwxyz';
        if (options.digits) chars += '0123456789';
        if (options.special) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
        if (options.brackets) chars += '[]{}()<>';
        if (options.space) chars += ' ';
        if (options.minus) chars += '-';
        if (options.underline) chars += '_';
        if (options.latin1) chars += 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ';
        if (options.customChars) chars += options.customChars;
        return chars;
    };

    const generatePassword = () => {
        const chars = generateCharacterPool();
        if (!chars) {
            (window as any).showToast?.({
                message: 'Please select at least one character set',
                type: 'error'
            });
            return;
        }

        const password = Array.from(crypto.getRandomValues(new Uint8Array(options.length)))
            .map(byte => chars[byte % chars.length])
            .join('');

        setGeneratedPassword(password);

        // Check strength of generated password
        HaveIBeenPwnedService.checkPassword(password).then(result => {
            setPasswordStrength(result.strength);
        });
    };

    const handleSave = () => {
        if (!generatedPassword) {
            (window as any).showToast?.({
                message: 'Please generate a password first',
                type: 'error'
            });
            return;
        }
        onSave(kdbxweb.ProtectedValue.fromString(generatedPassword));
        onClose();
    };

    const copyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(generatedPassword);
            (window as any).showToast?.({
                message: 'Password copied to clipboard',
                type: 'success'
            });
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            (window as any).showToast?.({
                message: 'Failed to copy to clipboard',
                type: 'error'
            });
        }
    };

    return (
        <div className="modal-overlay">
            <div className="password-generator-modal">
                <div className="modal-header">
                    <h2>Generate New Password</h2>
                    <button className="close-button" onClick={onClose}>
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="generated-password-section">
                    <div className="password-display">
                        <input
                            type="text"
                            value={generatedPassword}
                            readOnly
                            placeholder="Generated password will appear here"
                        />
                        <div className="password-actions">
                            <button onClick={copyToClipboard} title="Copy password">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                            </button>
                            <button onClick={generatePassword} title="Generate new password">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M23 4v6h-6" />
                                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    {passwordStrength && (
                        <div className={`password-strength strength-${passwordStrength.score}`}>
                            <div className="strength-bar">
                                <div
                                    className="strength-fill"
                                    style={{ width: `${(passwordStrength.score + 1) * 20}%` }}
                                />
                            </div>
                            <div className="strength-label">
                                {passwordStrength.score === 0 && 'Very Weak'}
                                {passwordStrength.score === 1 && 'Weak'}
                                {passwordStrength.score === 2 && 'Fair'}
                                {passwordStrength.score === 3 && 'Strong'}
                                {passwordStrength.score === 4 && 'Very Strong'}
                            </div>
                        </div>
                    )}
                </div>

                <div className="password-options">
                    <div className="option-group">
                        <label>Password Length</label>
                        <div className="length-control">
                            <input
                                type="range"
                                min="1"
                                max="128"
                                value={options.length}
                                onChange={(e) => setOptions({ ...options, length: parseInt(e.target.value) })}
                            />
                            <input
                                type="number"
                                min="1"
                                max="128"
                                value={options.length}
                                onChange={(e) => setOptions({ ...options, length: parseInt(e.target.value) })}
                            />
                        </div>
                    </div>

                    <div className="option-group">
                        <label>Character Sets</label>
                        <div className="checkbox-group">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.upperCase}
                                    onChange={(e) => setOptions({ ...options, upperCase: e.target.checked })}
                                />
                                Upper-case (A-Z)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.lowerCase}
                                    onChange={(e) => setOptions({ ...options, lowerCase: e.target.checked })}
                                />
                                Lower-case (a-z)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.digits}
                                    onChange={(e) => setOptions({ ...options, digits: e.target.checked })}
                                />
                                Digits (0-9)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.special}
                                    onChange={(e) => setOptions({ ...options, special: e.target.checked })}
                                />
                                Special (!@#$%^&*()_+-=[]{}|;:,.'&lt;&gt;'?)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.brackets}
                                    onChange={(e) => setOptions({ ...options, brackets: e.target.checked })}
                                />
                                Brackets ([]{}())
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.space}
                                    onChange={(e) => setOptions({ ...options, space: e.target.checked })}
                                />
                                Space
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.minus}
                                    onChange={(e) => setOptions({ ...options, minus: e.target.checked })}
                                />
                                Minus (-)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.underline}
                                    onChange={(e) => setOptions({ ...options, underline: e.target.checked })}
                                />
                                Underline (_)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.latin1}
                                    onChange={(e) => setOptions({ ...options, latin1: e.target.checked })}
                                />
                                Latin-1 Special Characters
                            </label>
                        </div>
                    </div>

                    <div className="option-group">
                        <label>Custom Characters</label>
                        <input
                            type="text"
                            value={options.customChars}
                            onChange={(e) => setOptions({ ...options, customChars: e.target.value })}
                            placeholder="Add your own characters"
                        />
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="cancel-button" onClick={onClose}>
                        Cancel
                    </button>
                    <button className="save-button" onClick={handleSave}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
};
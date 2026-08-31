import { useState, useEffect } from 'react';
import './PasswordGenerator.css';
import * as kdbxweb from 'kdbxweb';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';
import { PassphraseService, PassphraseOptions } from '../../services/PassphraseService';
import { CloseActionIcon, CopyActionIcon, RefreshActionIcon } from '../../icons/actions/ActionIcons';

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

type GeneratorMode = 'characters' | 'words';

export const PasswordGenerator = ({ onClose, onSave, currentPassword }: PasswordGeneratorProps) => {
    const [generatedPassword, setGeneratedPassword] = useState('');
    const [mode, setMode] = useState<GeneratorMode>('characters');
    const [passphraseOptions, setPassphraseOptions] = useState<PassphraseOptions>({
        wordCount: 5,
        separator: '-',
        capitalize: false,
        includeNumber: false,
    });
    const [passphraseBits, setPassphraseBits] = useState<number | null>(null);
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
        setPassphraseBits(null);

        // Check strength of generated password locally (no network call)
        setPasswordStrength(HaveIBeenPwnedService.checkPasswordStrength(password));
    };

    const generatePassphrase = (opts: PassphraseOptions = passphraseOptions) => {
        const phrase = PassphraseService.generate(opts);
        const bits = PassphraseService.entropyBits(opts);
        setGeneratedPassword(phrase);
        setPassphraseBits(bits);
        const score = bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
        setPasswordStrength({ score, feedback: { warning: '', suggestions: [] } });
    };

    const regenerate = () => {
        if (mode === 'words') generatePassphrase();
        else generatePassword();
    };

    const switchMode = (next: GeneratorMode) => {
        if (next === mode) return;
        setMode(next);
        if (next === 'words') generatePassphrase();
        else generatePassword();
    };

    const updatePassphraseOptions = (patch: Partial<PassphraseOptions>) => {
        const next = { ...passphraseOptions, ...patch };
        setPassphraseOptions(next);
        generatePassphrase(next);
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
                <div className="generator-modal-header">
                    <h2>Generate New Password</h2>
                    <button className="generator-close-button" onClick={onClose}>
                        <CloseActionIcon />
                    </button>
                </div>

                <div className="generator-tabs">
                    <button
                        className={`generator-tab ${mode === 'characters' ? 'active' : ''}`}
                        onClick={() => switchMode('characters')}
                    >
                        Characters
                    </button>
                    <button
                        className={`generator-tab ${mode === 'words' ? 'active' : ''}`}
                        onClick={() => switchMode('words')}
                    >
                        Passphrase
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
                                <CopyActionIcon />
                            </button>
                            <button onClick={regenerate} title="Generate new password">
                                <RefreshActionIcon />
                            </button>
                        </div>
                    </div>
                    {passwordStrength && (
                        <div className={`generator-password-strength strength-${passwordStrength.score}`}>
                            <div className="generator-strength-bar">
                                <div
                                    className="strength-fill"
                                    style={{ width: `${(passwordStrength.score + 1) * 20}%` }}
                                />
                            </div>
                            <div className="generator-strength-label">
                                {passwordStrength.score === 0 && 'Very Weak'}
                                {passwordStrength.score === 1 && 'Weak'}
                                {passwordStrength.score === 2 && 'Fair'}
                                {passwordStrength.score === 3 && 'Strong'}
                                {passwordStrength.score === 4 && 'Very Strong'}
                                {passphraseBits !== null && ` (~${passphraseBits} bits)`}
                            </div>
                        </div>
                    )}
                </div>

                <div className="password-options">
                    {mode === 'words' && (
                        <>
                            <div className="option-group">
                                <label>Number of Words</label>
                                <div className="length-control">
                                    <input
                                        type="range"
                                        min="3"
                                        max="12"
                                        value={passphraseOptions.wordCount}
                                        onChange={(e) => updatePassphraseOptions({ wordCount: parseInt(e.target.value) })}
                                    />
                                    <input
                                        type="number"
                                        min="3"
                                        max="12"
                                        value={passphraseOptions.wordCount}
                                        onChange={(e) => {
                                            const n = parseInt(e.target.value);
                                            if (!isNaN(n)) updatePassphraseOptions({ wordCount: Math.min(12, Math.max(3, n)) });
                                        }}
                                    />
                                </div>
                            </div>
                            <div className="option-group">
                                <label>Word Separator</label>
                                <input
                                    type="text"
                                    className="generator-separator-input"
                                    maxLength={4}
                                    value={passphraseOptions.separator}
                                    onChange={(e) => updatePassphraseOptions({ separator: e.target.value })}
                                    placeholder="-"
                                />
                            </div>
                            <div className="option-group">
                                <label>Options</label>
                                <div className="checkbox-group">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={passphraseOptions.capitalize}
                                            onChange={(e) => updatePassphraseOptions({ capitalize: e.target.checked })}
                                        />
                                        Capitalize words
                                    </label>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={passphraseOptions.includeNumber}
                                            onChange={(e) => updatePassphraseOptions({ includeNumber: e.target.checked })}
                                        />
                                        Include a number
                                    </label>
                                </div>
                            </div>
                            <p className="generator-wordlist-note">
                                Words are drawn from the EFF large wordlist (7,776 words, ~12.9 bits of entropy per word).
                            </p>
                        </>
                    )}
                    {mode === 'characters' && (
                    <>
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
                    </>
                    )}
                </div>

                <div className="generator-modal-footer">
                    <button className="generator-cancel-button" onClick={onClose}>
                        Cancel
                    </button>
                    <button className="generator-save-button" onClick={handleSave}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
};
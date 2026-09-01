import { useState, useEffect, useSyncExternalStore } from 'react';
import './PasswordGenerator.css';
import * as kdbxweb from 'kdbxweb';
import { HaveIBeenPwnedService } from '../../services/HaveIBeenPwnedService';
import { PassphraseService, PassphraseOptions } from '../../services/PassphraseService';
import {
    PasswordGeneratorService,
    PasswordOptions,
    GeneratorMode,
    GeneratorSettings,
} from '../../services/PasswordGeneratorService';
import { CloseActionIcon, CopyActionIcon, RefreshActionIcon } from '../../icons/actions/ActionIcons';
import { ClipboardService, CLIPBOARD_CLEAR_SECONDS } from '../../services/ClipboardService';

// Only one generator is open at a time, so a constant identifies its copy
// button well enough to keep the countdown badge off every entry's password
// field, which carries the same label
const COPY_SOURCE = 'generator';

interface PasswordGeneratorProps {
    onClose: () => void;
    onSave: (password: kdbxweb.ProtectedValue) => void;
    currentPassword?: string;
}

export const PasswordGenerator = ({ onClose, onSave, currentPassword }: PasswordGeneratorProps) => {
    // Settings persist so the next open (and the browser extension's
    // generate-password) uses what the user last picked
    const [savedSettings] = useState<GeneratorSettings>(() => PasswordGeneratorService.loadSettings());
    const [generatedPassword, setGeneratedPassword] = useState('');
    // Shows how long before the copied password leaves the clipboard
    const clipboard = useSyncExternalStore(ClipboardService.subscribe, ClipboardService.getSnapshot);
    const [mode, setMode] = useState<GeneratorMode>(savedSettings.mode);
    const [passphraseOptions, setPassphraseOptions] = useState<PassphraseOptions>(savedSettings.passphrase);
    const [passphraseBits, setPassphraseBits] = useState<number | null>(null);
    const [options, setOptions] = useState<PasswordOptions>(() => {
        if (!currentPassword) return savedSettings.password;

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
        // Generate with the remembered mode when the modal opens
        if (mode === 'words') generatePassphrase();
        else generatePassword();
    }, []); // Empty dependency array means this runs once on mount

    const [passwordStrength, setPasswordStrength] = useState<{
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    } | null>(null);

    const persistSettings = (patch: Partial<GeneratorSettings>) => {
        PasswordGeneratorService.saveSettings({
            mode,
            password: options,
            passphrase: passphraseOptions,
            ...patch,
        });
    };

    const generatePassword = () => {
        if (!PasswordGeneratorService.characterPool(options)) {
            (window as any).showToast?.({
                message: 'Please select at least one character set',
                type: 'error'
            });
            return;
        }

        const password = PasswordGeneratorService.generate(options);
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
        persistSettings({ mode: next });
        if (next === 'words') generatePassphrase();
        else generatePassword();
    };

    const updateOptions = (patch: Partial<PasswordOptions>) => {
        const next = { ...options, ...patch };
        setOptions(next);
        persistSettings({ password: next });
    };

    const updatePassphraseOptions = (patch: Partial<PassphraseOptions>) => {
        const next = { ...passphraseOptions, ...patch };
        setPassphraseOptions(next);
        persistSettings({ passphrase: next });
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

    // Goes through the service so the generated password is cleared from the
    // clipboard on the same countdown as one copied from an entry. The
    // countdown outlives this modal, which is normally closed right after
    const copyToClipboard = () => ClipboardService.copy(generatedPassword, 'Password', COPY_SOURCE);

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
                            <button className="generator-copy-button" onClick={copyToClipboard} title="Copy password">
                                <CopyActionIcon />
                                {clipboard.secondsLeft > 0 && clipboard.source === COPY_SOURCE && (
                                    <div
                                        className="clipboard-timer"
                                        style={{ '--progress': `${(clipboard.secondsLeft / CLIPBOARD_CLEAR_SECONDS) * 100}%` } as React.CSSProperties}
                                    >
                                        {clipboard.secondsLeft}s
                                    </div>
                                )}
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
                                onChange={(e) => updateOptions({length: parseInt(e.target.value) })}
                            />
                            <input
                                type="number"
                                min="1"
                                max="128"
                                value={options.length}
                                onChange={(e) => updateOptions({length: parseInt(e.target.value) })}
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
                                    onChange={(e) => updateOptions({upperCase: e.target.checked })}
                                />
                                Upper-case (A-Z)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.lowerCase}
                                    onChange={(e) => updateOptions({lowerCase: e.target.checked })}
                                />
                                Lower-case (a-z)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.digits}
                                    onChange={(e) => updateOptions({digits: e.target.checked })}
                                />
                                Digits (0-9)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.special}
                                    onChange={(e) => updateOptions({special: e.target.checked })}
                                />
                                Special (!@#$%^&*()_+-=[]{}|;:,.'&lt;&gt;'?)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.brackets}
                                    onChange={(e) => updateOptions({brackets: e.target.checked })}
                                />
                                Brackets ([]{}())
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.space}
                                    onChange={(e) => updateOptions({space: e.target.checked })}
                                />
                                Space
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.minus}
                                    onChange={(e) => updateOptions({minus: e.target.checked })}
                                />
                                Minus (-)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.underline}
                                    onChange={(e) => updateOptions({underline: e.target.checked })}
                                />
                                Underline (_)
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.latin1}
                                    onChange={(e) => updateOptions({latin1: e.target.checked })}
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
                            onChange={(e) => updateOptions({customChars: e.target.value })}
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
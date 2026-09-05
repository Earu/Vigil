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
import { ClipboardService } from '../../services/ClipboardService';
import { Modal } from '../Modal';
import { TabStrip, tabPanelProps } from '../TabStrip';

// Only one generator is open at a time, so a constant identifies its copy
// button well enough to keep the countdown badge off every entry's password
// field, which carries the same label
const COPY_SOURCE = 'generator';

interface PasswordGeneratorProps {
    onClose: () => void;
    onSave: (password: kdbxweb.ProtectedValue) => void;
    currentPassword?: string;
}

// The generator options that would produce a password shaped like this one:
// same length, same character classes. Used to seed the generator when it
// opens on an existing entry, so a regenerated password fits the site's
// rules the old one met
function optionsMatching(password: string): PasswordOptions {
    return {
        length: password.length,
        upperCase: /[A-Z]/.test(password),
        lowerCase: /[a-z]/.test(password),
        digits: /[0-9]/.test(password),
        special: /[!@#$%^&*()_+=\[\]{}|;:,.<>?]/.test(password),
        brackets: /[\[\]{}()]/.test(password),
        space: /\s/.test(password),
        minus: /-/.test(password),
        underline: /_/.test(password),
        latin1: /[À-ÿ]/.test(password),
        customChars: '',
    };
}

export const PasswordGenerator = ({ onClose, onSave, currentPassword }: PasswordGeneratorProps) => {
    // Settings persist so the next open (and the browser extension's
    // generate-password) uses what the user last picked
    const [savedSettings] = useState<GeneratorSettings>(() => PasswordGeneratorService.loadSettings());
    const [generatedPassword, setGeneratedPassword] = useState('');
    // Shows how long before the copied password leaves the clipboard
    const clipboard = useSyncExternalStore(ClipboardService.subscribe, ClipboardService.getSnapshot);
    const [mode, setMode] = useState<GeneratorMode>(savedSettings.mode);
    const [wordOptions, setWordOptions] = useState<PassphraseOptions>(savedSettings.words);
    const [passphraseBits, setPassphraseBits] = useState<number | null>(null);
    // Options seeded from an existing password describe that password: its
    // length and which character classes it uses. They are held apart from
    // the remembered options and never reach storage, where they would say
    // that much about the last edited entry in the clear. What is remembered
    // is only ever what was picked in a generator opened fresh
    const [seededOptions, setSeededOptions] = useState<PasswordOptions | null>(
        () => currentPassword ? optionsMatching(currentPassword) : null);
    const [rememberedOptions, setRememberedOptions] = useState<PasswordOptions>(savedSettings.characters);
    const options = seededOptions ?? rememberedOptions;

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
            characters: rememberedOptions,
            words: wordOptions,
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

    const generatePassphrase = async (opts: PassphraseOptions = wordOptions) => {
        // Wordlist is a lazy chunk; instant once cached
        await PassphraseService.preload();
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
        // A change to seeded options stays with them, and with this session
        if (seededOptions) {
            setSeededOptions({ ...seededOptions, ...patch });
            return;
        }
        const next = { ...rememberedOptions, ...patch };
        setRememberedOptions(next);
        persistSettings({ characters: next });
    };

    const updateWordOptions = (patch: Partial<PassphraseOptions>) => {
        const next = { ...wordOptions, ...patch };
        setWordOptions(next);
        persistSettings({ words: next });
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
        <Modal overlayClassName="modal-overlay" className="password-generator-modal" labelledBy="generator-title" onClose={onClose} initialFocus="container">
                <div className="generator-modal-header">
                    <h2 id="generator-title">Generate New Password</h2>
                    <button className="generator-close-button" onClick={onClose} aria-label="Close password generator">
                        <CloseActionIcon />
                    </button>
                </div>

                <TabStrip
                    idPrefix="generator"
                    label="Password type"
                    tabs={[
                        { id: 'characters' as const, label: 'Characters' },
                        { id: 'words' as const, label: 'Passphrase' },
                    ]}
                    active={mode}
                    onChange={switchMode}
                    className="generator-tabs"
                    tabClassName="generator-tab"
                />

                <div className="generated-password-section">
                    <div className="password-display">
                        <input
                            type="text"
                            value={generatedPassword}
                            readOnly
                            aria-label="Generated password"
                            placeholder="Generated password will appear here"
                        />
                        <div className="password-actions">
                            <button
                                className="generator-copy-button"
                                onClick={copyToClipboard}
                                title="Copy password"
                                aria-label={clipboard.secondsLeft > 0 && clipboard.source === COPY_SOURCE
                                    ? `Copy password, clipboard clears in ${clipboard.secondsLeft} seconds`
                                    : 'Copy password'}
                            >
                                <CopyActionIcon />
                                {clipboard.secondsLeft > 0 && clipboard.source === COPY_SOURCE && (
                                    <div
                                        className="clipboard-timer"
                                        style={{ '--progress': `${(clipboard.secondsLeft / clipboard.totalSeconds) * 100}%` } as React.CSSProperties}
                                    >
                                        {clipboard.secondsLeft}s
                                    </div>
                                )}
                            </button>
                            <button onClick={regenerate} title="Generate new password" aria-label="Generate new password">
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

                <div className="password-options" {...tabPanelProps('generator', mode)}>
                    {mode === 'words' && (
                        <>
                            <div className="option-group">
                                <label htmlFor="generator-word-count">Number of Words</label>
                                <div className="length-control">
                                    <input
                                        type="range"
                                        aria-label="Number of words"
                                        min="3"
                                        max="12"
                                        value={wordOptions.wordCount}
                                        onChange={(e) => updateWordOptions({ wordCount: parseInt(e.target.value) })}
                                    />
                                    <input
                                        id="generator-word-count"
                                        type="number"
                                        min="3"
                                        max="12"
                                        value={wordOptions.wordCount}
                                        onChange={(e) => {
                                            const n = parseInt(e.target.value);
                                            if (!isNaN(n)) updateWordOptions({ wordCount: Math.min(12, Math.max(3, n)) });
                                        }}
                                    />
                                </div>
                            </div>
                            <div className="option-group">
                                <label htmlFor="generator-separator">Word Separator</label>
                                <input
                                    id="generator-separator"
                                    type="text"
                                    className="generator-separator-input"
                                    maxLength={4}
                                    value={wordOptions.separator}
                                    onChange={(e) => updateWordOptions({ separator: e.target.value })}
                                    placeholder="-"
                                />
                            </div>
                            <div className="option-group">
                                <label id="generator-word-options">Options</label>
                                <div className="checkbox-group" role="group" aria-labelledby="generator-word-options">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={wordOptions.capitalize}
                                            onChange={(e) => updateWordOptions({ capitalize: e.target.checked })}
                                        />
                                        Capitalize words
                                    </label>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={wordOptions.includeNumber}
                                            onChange={(e) => updateWordOptions({ includeNumber: e.target.checked })}
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
                        <label htmlFor="generator-length">Password Length</label>
                        <div className="length-control">
                            <input
                                type="range"
                                aria-label="Password length"
                                min="1"
                                max="128"
                                value={options.length}
                                onChange={(e) => updateOptions({length: parseInt(e.target.value) })}
                            />
                            <input
                                id="generator-length"
                                type="number"
                                min="1"
                                max="128"
                                value={options.length}
                                onChange={(e) => updateOptions({length: parseInt(e.target.value) })}
                            />
                        </div>
                    </div>

                    <div className="option-group">
                        <label id="generator-character-sets">Character Sets</label>
                        <div className="checkbox-group" role="group" aria-labelledby="generator-character-sets">
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
                        <label htmlFor="generator-custom-chars">Custom Characters</label>
                        <input
                            id="generator-custom-chars"
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
        </Modal>
    );
};
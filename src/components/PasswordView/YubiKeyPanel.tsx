import { useCallback, useEffect, useRef, useState } from 'react';
import * as kdbxweb from 'kdbxweb';
import { OathAccount, OathFailure } from '../../types/electron';
import { ClipboardService } from '../../services/ClipboardService';
import { SpinnerIcon } from '../../icons/status/StatusIcons';
import { CloseActionIcon, CopyActionIcon, RefreshActionIcon, GenerateActionIcon } from '../../icons/actions/ActionIcons';
import { Modal } from '../Modal';
import { HardwareKeyTouchDialog } from '../HardwareKeyTouchDialog';
import { OATH_FAILURES } from './oathFailures';
import './YubiKeyPanel.css';

// Codes from the OATH application on a connected YubiKey.
//
// Read-only on purpose: the protocol has no instruction that reads a secret
// back off the key, so these accounts cannot be backed up, exported, or
// recovered by Vigil. They are the key's, not the vault's, and the panel says
// so rather than letting them sit next to entries that Vigil does protect.

interface YubiKeyPanelProps {
    onClose: () => void;
}


const YKMAN_DOCS = 'https://docs.yubico.com/software/yubikey/tools/ykman/';

// The one command most people on each platform need. Linux gets a package
// manager guess plus the portable route, because the distro spread is wide
const INSTALL: Record<string, { label: string; commands: string[] }> = {
    darwin: { label: 'On macOS:', commands: ['brew install ykman'] },
    win32: { label: 'On Windows:', commands: ['winget install Yubico.YubiKeyManagerCLI'] },
    linux: {
        label: 'On Linux, from your package manager:',
        commands: [
            'pacman -S yubikey-manager',
            'apt install yubikey-manager',
            'dnf install yubikey-manager',
        ],
    },
};

export const YubiKeyPanel = ({ onClose }: YubiKeyPanelProps) => {
    const [accounts, setAccounts] = useState<OathAccount[] | null>(null);
    const [failure, setFailure] = useState<OathFailure | null>(null);
    const [detail, setDetail] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [password, setPassword] = useState('');
    // Held only while the panel is open, and only when the key asked for it.
    // A ProtectedValue rather than a string, the way the model holds entry
    // passwords: no plaintext copy sits in the heap between calls, where a
    // dropped JS string would linger until collected. Each call still
    // decrypts it for the trip over IPC to ykman's stdin
    const [heldPassword, setHeldPassword] = useState<kdbxweb.ProtectedValue | null>(null);
    const heldText = () => heldPassword?.getText() ?? null;
    // The account whose code is being calculated, so the row can say so
    const [busyId, setBusyId] = useState<string | null>(null);
    const [touchPending, setTouchPending] = useState(false);
    const [platform, setPlatform] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        void window.electron?.getPlatform?.().then(value => {
            if (!cancelled) setPlatform(value);
        });
        return () => { cancelled = true; };
    }, []);

    const inFlight = useRef(false);

    const load = useCallback(async (withPassword: string | null) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        const result = await window.electron?.yubikeyOathAccounts?.(null, withPassword);
        inFlight.current = false;
        setLoading(false);
        if (!result) return;
        if (result.ok) {
            setAccounts(result.value ?? []);
            setFailure(null);
            setDetail(null);
            setHeldPassword(withPassword === null ? null : kdbxweb.ProtectedValue.fromString(withPassword));
            setPassword('');
            return;
        }
        setAccounts(null);
        setFailure(result.error ?? 'failed');
        setDetail(result.detail ?? null);
    }, []);

    useEffect(() => { void load(null); }, [load]);

    // HOTP and touch-required accounts hand back no code from the batch read,
    // because calculating one has a consequence: an HOTP counter moves on the
    // key and cannot be moved back, and a touch account lights up and waits
    const generate = async (account: OathAccount) => {
        setBusyId(account.id);
        // The key blinks and waits as soon as ykman asks, so the prompt goes
        // up before the call rather than off the back of anything it prints.
        // An HOTP account may be touch-protected too, and the batch read
        // cannot tell us: ykman itself assumes touch after 500ms
        setTouchPending(account.requiresTouch || account.type === 'HOTP');
        const result = await window.electron?.yubikeyOathCode?.(null, account.id, heldText());
        setTouchPending(false);
        setBusyId(null);
        if (!result?.ok || !result.value) {
            setFailure(result?.error ?? 'failed');
            setDetail(result?.detail ?? null);
            return;
        }
        const code = result.value;
        setAccounts(current => current?.map(a => (a.id === account.id ? { ...a, code } : a)) ?? current);
    };

    const copy = (code: string) => ClipboardService.copy(code, 'One-time code', 'yubikey-oath');

    // An install command is not a secret, so it skips ClipboardService and the
    // auto-clear countdown that comes with it
    const copyCommand = async (command: string) => {
        try {
            await navigator.clipboard.writeText(command);
            (window as any).showToast?.({ message: 'Command copied', type: 'success' });
        } catch {
            (window as any).showToast?.({ message: 'Could not copy the command', type: 'error' });
        }
    };

    const renderRow = (account: OathAccount) => (
        <div className="yubikey-row" key={account.id}>
            <div className="yubikey-row-labels">
                <span className="yubikey-row-name">{account.name}</span>
                {account.issuer && <span className="yubikey-row-issuer">{account.issuer}</span>}
            </div>
            <span className="yubikey-row-type">
                {account.type}
                {account.type === 'TOTP' && account.period !== 30 && ` ${account.period}s`}
            </span>
            {account.code ? (
                <span className="yubikey-row-code">
                    {account.code.slice(0, Math.ceil(account.code.length / 2))}&thinsp;{account.code.slice(Math.ceil(account.code.length / 2))}
                </span>
            ) : (
                <button
                    className="generate-button"
                    onClick={() => generate(account)}
                    disabled={busyId !== null}
                    title={account.requiresTouch ? 'Generate a code, then touch the key' : 'Generate a code and advance the counter on the key'}
                    aria-label={account.requiresTouch ? 'Generate a code, then touch the key' : 'Generate a code and advance the counter on the key'}
                    type="button"
                >
                    {busyId === account.id ? <SpinnerIcon className="spinner" /> : <GenerateActionIcon />}
                </button>
            )}
            <button
                className="copy-button"
                onClick={() => account.code && copy(account.code)}
                disabled={!account.code}
                title="Copy one-time code"
                aria-label="Copy one-time code"
                type="button"
            >
                <CopyActionIcon />
            </button>
        </div>
    );

    return (
        <Modal
            overlayClassName="yubikey-panel-overlay"
            className="yubikey-panel"
            labelledBy="yubikey-panel-title"
            describedBy="yubikey-panel-note"
            onClose={onClose}
            initialFocus="container"
        >
            <div className="yubikey-panel-header">
                <h2 id="yubikey-panel-title">YubiKey</h2>
                <button
                    className="report-close-button"
                    onClick={() => void load(heldText())}
                    disabled={loading}
                    title="Refresh"
                    aria-label="Refresh the accounts on the key"
                    type="button"
                >
                    {loading ? <SpinnerIcon className="spinner" /> : <RefreshActionIcon />}
                </button>
                <button className="report-close-button" onClick={onClose} aria-label="Close the YubiKey panel" type="button">
                    <CloseActionIcon />
                </button>
            </div>

            <p className="yubikey-panel-note" id="yubikey-panel-note">
                These accounts live on the key. Vigil shows their codes and nothing more.
            </p>

            {loading && accounts === null && (
                <div className="yubikey-panel-state yubikey-panel-loading">
                    <SpinnerIcon className="spinner" /> Reading the key
                </div>
            )}

            {failure && (
                <div className="yubikey-panel-state yubikey-panel-error">
                    <strong>{OATH_FAILURES[failure].message}</strong>
                    <span>{OATH_FAILURES[failure].hint}</span>
                    {detail && failure !== 'ykman-missing' && <code className="yubikey-panel-detail">{detail}</code>}
                    {failure === 'ykman-missing' && (
                        <div className="yubikey-install">
                            <span className="yubikey-install-label">
                                {INSTALL[platform ?? 'linux']?.label ?? 'Install ykman:'}
                            </span>
                            {(INSTALL[platform ?? 'linux']?.commands ?? []).map(command => (
                                <div className="yubikey-install-row" key={command}>
                                    <code className="yubikey-install-command">{command}</code>
                                    <button
                                        className="copy-button"
                                        onClick={() => void copyCommand(command)}
                                        title="Copy command"
                                        aria-label={`Copy the command ${command}`}
                                        type="button"
                                    >
                                        <CopyActionIcon />
                                    </button>
                                </div>
                            ))}
                            <button
                                className="yubikey-install-link"
                                onClick={() => void window.electron?.openExternal?.(YKMAN_DOCS)}
                                type="button"
                            >
                                Yubico's install guide
                            </button>
                        </div>
                    )}
                    {(failure === 'locked' || failure === 'wrong-password') && (
                        <form
                            className="yubikey-panel-unlock"
                            onSubmit={event => { event.preventDefault(); void load(password); }}
                        >
                            <input
                                type="password"
                                value={password}
                                onChange={event => setPassword(event.target.value)}
                                placeholder="OATH password"
                                aria-label="OATH password"
                            />
                            <button type="submit" disabled={!password}>Unlock</button>
                        </form>
                    )}
                </div>
            )}

            {accounts?.length === 0 && !failure && (
                <div className="yubikey-panel-state">No accounts are stored on this key.</div>
            )}

            {accounts && accounts.length > 0 && (
                <div className={`yubikey-rows${loading ? ' yubikey-rows-stale' : ''}`} aria-busy={loading}>
                    {accounts.map(renderRow)}
                </div>
            )}

            {touchPending && <HardwareKeyTouchDialog />}
        </Modal>
    );
};

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { ClipboardService } from '../services/ClipboardService';
import type { TpmLimitChange, TpmSetupStep } from '../types/electron';
import './BrowserPairingDialog.css';
import './TpmSetupDialog.css';

type Stage =
    | { kind: 'loading' }
    | { kind: 'access' }
    | { kind: 'manual'; error: string; commands: string[] }
    | { kind: 'lockout' }
    | { kind: 'limits'; change: TpmLimitChange }
    | { kind: 'show'; password: string }
    | { kind: 'confirm'; password: string }
    | { kind: 'foreign-lockout' }
    | { kind: 'too-few-tries' }
    | { kind: 'unreachable' }
    | { kind: 'leave'; commands?: string[] }
    | { kind: 'done' };

const UNPROTECTED_STAGES: Stage['kind'][] = ['lockout', 'limits', 'show', 'confirm'];

const FOREIGN_COMMAND = 'read -rs PASS; printf \'%s\' "$PASS" | tpm2_dictionarylockout --setup-parameters --max-tries=32 --recovery-time=7200 -p file:-; unset PASS';

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

const tries = (count: number) => count >= 0xffffffff ? 'unlimited' : count.toLocaleString('en-US');

const duration = (seconds: number) => {
    if (seconds === 0) return 'off, wrong PINs are not counted';
    if (seconds < 60) return plural(seconds, 'second');
    if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute');
    return plural(Math.round(seconds / 3600), 'hour');
};

const stageFor = (step: TpmSetupStep | null): Stage => step === null ? { kind: 'done' } : { kind: step };

interface TpmSetupDialogProps {
    onClose: () => void;
}

export const TpmSetupDialog = ({ onClose }: TpmSetupDialogProps) => {
    const electron = window.electron!;
    const [stage, setStage] = useState<Stage>({ kind: 'loading' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [typed, setTyped] = useState('');
    const [grantedHere, setGrantedHere] = useState(false);

    const refresh = async () => {
        setError(null);
        setStage(stageFor(await electron.getTpmSetupStep()));
    };

    useEffect(() => {
        void refresh();
    }, []);

    const close = () => {
        if (stage.kind === 'show' || stage.kind === 'confirm') void electron.cancelTpmLockout();
        if (grantedHere && UNPROTECTED_STAGES.includes(stage.kind)) {
            setError(null);
            setTyped('');
            setStage({ kind: 'leave' });
            return;
        }
        onClose();
    };

    const revokeAccess = async () => {
        setBusy(true);
        setError(null);
        const result = await electron.revokeTpmAccess();
        setBusy(false);
        if (result.success) {
            onClose();
        } else if (result.commands) {
            setError(result.error ?? 'Vigil could not remove access');
            setStage({ kind: 'leave', commands: result.commands });
        } else if (!result.cancelled) {
            setError(result.error ?? 'Vigil could not remove access');
        }
    };

    const planLockout = async () => {
        setError(null);
        const plan = await electron.getTpmLockoutPlan();
        if (!plan.success) setError(plan.error);
        else if (plan.change) setStage({ kind: 'limits', change: plan.change });
        else await beginLockout(false);
    };

    const grantAccess = async () => {
        setBusy(true);
        setError(null);
        const result = await electron.grantTpmAccess();
        setBusy(false);
        if (result.success) {
            setGrantedHere(true);
            await refresh();
        } else if (result.commands) {
            setStage({ kind: 'manual', error: result.error ?? '', commands: result.commands });
        } else if (!result.cancelled) {
            setError(result.error ?? 'Vigil could not make the change');
        }
    };

    const beginLockout = async (acceptLimits: boolean) => {
        setError(null);
        const result = await electron.beginTpmLockout(acceptLimits);
        if (result.success) setStage({ kind: 'show', password: result.password });
        else setError(result.error);
    };

    const applyLockout = async () => {
        if (stage.kind !== 'confirm' || !typed.trim()) return;
        setBusy(true);
        setError(null);
        const result = await electron.applyTpmLockout(typed);
        setBusy(false);
        if (result.success) {
            setTyped('');
            setStage({ kind: 'done' });
        } else if (result.mismatch) {
            setError(result.error ?? 'This does not match the recovery password');
        } else {
            setTyped('');
            setError(result.error ?? 'Vigil could not set the recovery password');
            setStage({ kind: 'lockout' });
        }
    };

    const blockPaste = (e: React.ClipboardEvent | React.DragEvent) => e.preventDefault();

    const actions = (primary?: { label: string; onClick: () => void; disabled?: boolean }, secondary = 'Cancel', onSecondary = close) => (
        <div className="pairing-actions">
            <button className="pairing-cancel-button" onClick={onSecondary} disabled={busy}>{secondary}</button>
            {primary && (
                <button className="pairing-allow-button" onClick={primary.onClick} disabled={busy || primary.disabled}>
                    {primary.label}
                </button>
            )}
        </div>
    );

    const errorLine = error && <p className="tpm-setup-error" role="alert">{error}</p>;

    const body = () => {
        switch (stage.kind) {
            case 'loading':
                return <h3 id="tpm-setup-title">Set up PIN unlock</h3>;
            case 'access':
                return (
                    <>
                        <h3 id="tpm-setup-title">Set up PIN unlock</h3>
                        <p>
                            Your PIN is protected by a security chip in this computer. Vigil needs permission
                            to use it, which is a system change: your computer will ask for your administrator password.
                        </p>
                        <p>
                            Other apps you run will also be able to use the chip. Until it has a recovery password, a
                            harmful app could erase it, which may break features that rely on it, such as disk encryption
                            that unlocks on its own. You can remove this permission later in Settings.
                        </p>
                        {errorLine}
                        {actions({ label: busy ? 'Waiting...' : 'Continue', onClick: () => void grantAccess() })}
                    </>
                );
            case 'manual':
                return (
                    <>
                        <h3 id="tpm-setup-title">Set up PIN unlock</h3>
                        <p>{stage.error}</p>
                        <pre className="tpm-setup-commands">{stage.commands.join('\n')}</pre>
                        {actions({ label: 'Check again', onClick: () => void refresh() })}
                    </>
                );
            case 'lockout':
                return (
                    <>
                        <h3 id="tpm-setup-title">Limit wrong PIN guesses</h3>
                        <p>
                            Right now, software on this computer could try every possible PIN until one works, or erase the security chip.
                            Vigil can set a recovery password on the security chip so it blocks guessing after a few wrong PINs.
                        </p>
                        <p>
                            The recovery password protects the chip for the whole computer, not just Vigil.
                            You will not need it to use Vigil.
                        </p>
                        {errorLine}
                        {actions({ label: 'Continue', onClick: () => void planLockout() })}
                    </>
                );
            case 'limits':
                return (
                    <>
                        <h3 id="tpm-setup-title">Change this computer's limits</h3>
                        <p>
                            This computer's security chip lets software guess more PINs than PIN unlock allows.
                            Vigil needs to change these settings for the whole computer, not just Vigil:
                        </p>
                        <ul className="tpm-setup-limits">
                            {stage.change.maxTries && (
                                <li>
                                    Wrong PINs before guessing is blocked: {tries(stage.change.maxTries.from)} → {tries(stage.change.maxTries.to)}
                                </li>
                            )}
                            {stage.change.recoveryInterval && (
                                <li>
                                    Time before a wrong PIN is forgiven: {duration(stage.change.recoveryInterval.from)}
                                    {' → '}{duration(stage.change.recoveryInterval.to)}
                                </li>
                            )}
                        </ul>
                        {errorLine}
                        {actions({ label: 'Change limits', onClick: () => void beginLockout(true) })}
                    </>
                );
            case 'show':
                return (
                    <>
                        <h3 id="tpm-setup-title">Save your recovery password</h3>
                        <div className="tpm-setup-password">
                            <code>{stage.password}</code>
                            <button
                                className="pairing-cancel-button"
                                onClick={() => void ClipboardService.copy(stage.password, 'Recovery password', 'tpm-recovery')}
                            >
                                Copy
                            </button>
                        </div>
                        <p>
                            Save it in a password manager or write it down. You may need it to change the
                            security chip's settings later. If you lose it, PIN unlock keeps working.
                        </p>
                        {actions({ label: 'I saved it', onClick: () => setStage({ kind: 'confirm', password: stage.password }) })}
                    </>
                );
            case 'confirm':
                return (
                    <>
                        <h3 id="tpm-setup-title">Confirm your recovery password</h3>
                        <p>Type the recovery password from where you saved it. Pasting is turned off for this.</p>
                        <input
                            className="pairing-name-input tpm-setup-input"
                            aria-label="Recovery password"
                            value={typed}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            disabled={busy}
                            onChange={e => setTyped(e.target.value)}
                            onPaste={blockPaste}
                            onDrop={blockPaste}
                            onKeyDown={e => {
                                if (e.key === 'Enter') void applyLockout();
                            }}
                        />
                        {errorLine}
                        {actions(
                            { label: busy ? 'Setting...' : 'Set recovery password', onClick: () => void applyLockout(), disabled: !typed.trim() },
                            'Back',
                            () => {
                                setError(null);
                                setStage({ kind: 'show', password: stage.password });
                            }
                        )}
                    </>
                );
            case 'foreign-lockout':
                return (
                    <>
                        <h3 id="tpm-setup-title">Limit wrong PIN guesses</h3>
                        <p>
                            This computer's security chip already has a recovery password, set outside Vigil.
                            Vigil cannot change the guess limits without it. Whoever set it can run this, then type
                            the recovery password and press Enter:
                        </p>
                        <pre className="tpm-setup-commands">{FOREIGN_COMMAND}</pre>
                        <p>You can also allow PIN unlock without this in Settings.</p>
                        {actions(undefined, 'Close')}
                    </>
                );
            case 'too-few-tries':
                return (
                    <>
                        <h3 id="tpm-setup-title">Set up PIN unlock</h3>
                        <p>
                            This computer's security chip blocks guessing after fewer than 2 wrong PINs, so a single
                            typo would lock it for every app that uses it. Vigil leaves this setting as it is.
                        </p>
                        {actions(undefined, 'Close')}
                    </>
                );
            case 'unreachable':
                return (
                    <>
                        <h3 id="tpm-setup-title">Set up PIN unlock</h3>
                        <p>Vigil cannot reach this computer's security chip.</p>
                        {actions(undefined, 'Close')}
                    </>
                );
            case 'leave':
                return (
                    <>
                        <h3 id="tpm-setup-title">Remove access for now?</h3>
                        <p>
                            Apps you run can use the security chip, and it has no recovery password yet, so a harmful
                            app could erase it. You can remove this access now and set up PIN unlock later.
                        </p>
                        {stage.commands && <pre className="tpm-setup-commands">{stage.commands.join('\n')}</pre>}
                        {errorLine}
                        {actions(
                            { label: busy ? 'Waiting...' : 'Remove access', onClick: () => void revokeAccess() },
                            'Keep access',
                            onClose
                        )}
                    </>
                );
            case 'done':
                return (
                    <>
                        <h3 id="tpm-setup-title">Setup complete</h3>
                        <p>PIN unlock is ready to use on this computer.</p>
                        {actions(undefined, 'Close')}
                    </>
                );
        }
    };

    return (
        <Modal
            overlayClassName="pairing-overlay"
            className="pairing-dialog tpm-setup-dialog"
            labelledBy="tpm-setup-title"
            onClose={busy ? undefined : close}
        >
            {body()}
        </Modal>
    );
};

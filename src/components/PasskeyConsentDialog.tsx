import { useState } from 'react';
import { PasskeyConsentRequest } from '../services/BrowserIntegrationService';
import { normalizeOrigin, originMatchesRpId } from '../services/PasskeyService';
import { Modal } from './Modal';
import './PasskeyConsentDialog.css';

interface PasskeyConsentDialogProps {
    request: PasskeyConsentRequest;
    // register: any non-null string approves; get: the chosen credentialId
    onSubmit: (credentialId: string) => void;
    onCancel: () => void;
}

export const PasskeyConsentDialog = ({ request, onSubmit, onCancel }: PasskeyConsentDialogProps) => {
    const entries = request.entries ?? [];
    const [selected, setSelected] = useState(entries[0]?.credentialId ?? '');

    const isRegister = request.kind === 'register';
    // A registration for an account this database already holds a passkey
    // for replaces it: the old key stops signing in once the new one is
    // stored, so the dialog says which entry that is, as KeePassXC does
    const replaces = isRegister ? request.replaces : undefined;

    // Naming the relying party is enough while the page asking belongs to it,
    // which is what the site's own domain being the rpId or a subdomain of it
    // means. It stops being enough when the rpId was accepted only because
    // the relying party lists this caller as a related origin
    // (PasskeyService.validateRpId): the page is then some other site
    // entirely, and a dialog that says only "bank.com" describes a request
    // coming from somewhere the user cannot see
    //
    // The normalized form is what is shown: scheme, host and port identify
    // the caller, and the path the request may also carry has no bound and
    // nothing to say here. The slice is for an origin that will not
    // normalize, which cannot reach this dialog (the ceremony refuses it as
    // DOMAIN_IS_NOT_VALID first) but must not be rendered whole if it ever does
    const shownOrigin = normalizeOrigin(request.origin) ?? request.origin.slice(0, 253);
    const foreignOrigin = originMatchesRpId(request.origin, request.rpId) ? null : shownOrigin;

    return (
        <Modal overlayClassName="pairing-overlay" quietInitialFocus className="pairing-dialog passkey-dialog" labelledBy="passkey-title" onClose={onCancel}>
                <h3 id="passkey-title">{isRegister ? (replaces ? 'Replace Passkey' : 'Create Passkey') : 'Use Passkey'}</h3>
                {isRegister && replaces ? (
                    <p>
                        <strong>{request.rpId}</strong> wants to create a passkey
                        {request.username ? <> for <strong>{request.username}</strong></> : null},
                        and this database already holds one for that account in <strong>{replaces.title}</strong>.
                        Continuing replaces it: the current passkey stops working for this site,
                        and the old key remains only in the entry's history.
                    </p>
                ) : isRegister ? (
                    <p>
                        <strong>{request.rpId}</strong> wants to create a passkey
                        {request.username ? <> for <strong>{request.username}</strong></> : null}.
                        It will be stored in this database.
                    </p>
                ) : (
                    <p>
                        <strong>{request.rpId}</strong> is asking to sign in with a passkey
                        from this database.
                    </p>
                )}
                {foreignOrigin && (
                    <p className="passkey-origin-warning">
                        The page asking is <strong>{foreignOrigin}</strong>, which is not part
                        of {request.rpId}. It claims {request.rpId} allows it to sign in on its
                        behalf. Deny unless you know the two sites belong together.
                    </p>
                )}
                {!isRegister && entries.length > 0 && (
                    <div className="passkey-entry-list">
                        {entries.map((entry) => (
                            <label key={entry.credentialId} className="passkey-entry-row">
                                <input
                                    type="radio"
                                    name="passkey-entry"
                                    checked={selected === entry.credentialId}
                                    onChange={() => setSelected(entry.credentialId)}
                                />
                                <span className="passkey-entry-title">{entry.title}</span>
                                {entry.username && <span className="passkey-entry-username">{entry.username}</span>}
                            </label>
                        ))}
                    </div>
                )}
                <div className="pairing-actions">
                    <button className="pairing-cancel-button" onClick={onCancel}>Deny</button>
                    <button
                        className="pairing-allow-button"
                        disabled={!isRegister && !selected}
                        onClick={() => onSubmit(isRegister ? 'approved' : selected)}
                    >
                        {isRegister ? (replaces ? 'Replace' : 'Create') : 'Sign in'}
                    </button>
                </div>
        </Modal>
    );
};

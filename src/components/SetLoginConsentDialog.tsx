import { SetLoginConsentRequest } from '../services/BrowserIntegrationService';
import { BrowserIntegrationService } from '../services/BrowserIntegrationService';
import './BrowserPairingDialog.css';

interface SetLoginConsentDialogProps {
    request: SetLoginConsentRequest;
    onSubmit: () => void;
    onCancel: () => void;
}

export const SetLoginConsentDialog = ({ request, onSubmit, onCancel }: SetLoginConsentDialogProps) => {
    const host = BrowserIntegrationService.hostOf(request.url) || request.url;
    const isUpdate = request.mode === 'update';

    return (
        <div className="pairing-overlay">
            <div className="pairing-dialog">
                <h3>{isUpdate ? 'Update Login' : 'Save Login'}</h3>
                <p>
                    A browser is asking to {isUpdate ? 'update the password for' : 'save a new login for'}{' '}
                    <strong>{host}</strong>
                    {request.login ? <> as <strong>{request.login}</strong></> : null}
                    {isUpdate && request.entryTitle ? <> (entry "{request.entryTitle}")</> : null}.
                    Only allow this if you just saved a password in your browser.
                </p>
                <div className="pairing-actions">
                    <button className="pairing-cancel-button" onClick={onCancel}>Deny</button>
                    <button className="pairing-allow-button" onClick={onSubmit}>
                        {isUpdate ? 'Update' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
};

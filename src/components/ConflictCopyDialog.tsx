import { Modal } from './Modal';
import './BrowserPairingDialog.css';
import { MergeSummary } from '../services/KeepassDatabaseService';

export interface ConflictCopyRequest {
    copyName: string;
    vaultName: string;
    changes: MergeSummary;
}

interface ConflictCopyDialogProps {
    request: ConflictCopyRequest;
    onTrash: () => void;
    onKeep: () => void;
}

export const hasChanges = (changes: MergeSummary): boolean =>
    changes.added > 0 || changes.updated > 0 || changes.removed > 0 || changes.groups > 0;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const list = (parts: string[]): string =>
    parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

// "2 new entries, 1 entry with newer changes and 1 folder change"
export const describeChanges = (changes: MergeSummary): string => {
    const parts: string[] = [];
    if (changes.added > 0) parts.push(count(changes.added, 'new entry', 'new entries'));
    if (changes.updated > 0) parts.push(count(changes.updated, 'entry with newer changes', 'entries with newer changes'));
    if (changes.removed > 0) parts.push(count(changes.removed, 'entry deleted there', 'entries deleted there'));
    if (changes.groups > 0) parts.push(count(changes.groups, 'folder change', 'folder changes'));
    return list(parts);
};

// Shown after a conflict copy has been merged in memory (see
// KeepassDatabaseService.absorbConflictCopy). Keeping the copy is the default:
// a copy in the trash can come back, a merged version that never reached disk
// cannot, so when the merge changed anything, trashing is tied to saving first
export const ConflictCopyDialog = ({ request, onTrash, onKeep }: ConflictCopyDialogProps) => {
    const changed = hasChanges(request.changes);
    return (
        <Modal
            overlayClassName="pairing-overlay"
            className="pairing-dialog"
            role="alertdialog"
            labelledBy="conflict-copy-title"
            describedBy="conflict-copy-message"
            onClose={onKeep}
        >
                <h3 id="conflict-copy-title">Conflict Copy Found</h3>
                <p id="conflict-copy-message">
                    Your sync client kept a second version of <strong>{request.vaultName}</strong> as{' '}
                    <strong>{request.copyName}</strong>.{' '}
                    {changed
                        ? `It had ${describeChanges(request.changes)}, which are now in this vault. Save it and move the copy to the trash?`
                        : 'Everything in it is already in this vault. Move it to the trash?'}
                </p>
                <div className="pairing-actions">
                    <button className="pairing-cancel-button" onClick={onKeep} autoFocus>Keep the Copy</button>
                    <button className="pairing-allow-button" onClick={onTrash}>
                        {changed ? 'Save and Trash the Copy' : 'Trash the Copy'}
                    </button>
                </div>
        </Modal>
    );
};

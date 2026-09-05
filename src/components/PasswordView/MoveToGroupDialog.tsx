import { useMemo, useRef, useState } from 'react';
import { Database, Group } from '../../types/database';
import { Modal } from '../Modal';
import '../BrowserPairingDialog.css';
import '../PasskeyConsentDialog.css';
import './MoveToGroupDialog.css';

interface MoveToGroupDialogProps {
    database: Database;
    title: string;
    // The subtree that cannot be a destination (a group and its children)
    excludeId?: string;
    // The current parent: listed, but not a move
    currentParentId?: string;
    onChoose: (group: Group) => void;
    onCancel: () => void;
}

interface Row { group: Group; level: number }

const flatten = (group: Group, level: number, excludeId: string | undefined, out: Row[]): Row[] => {
    if (group.id === excludeId) return out;
    out.push({ group, level });
    for (const child of group.groups) flatten(child, level + 1, excludeId, out);
    return out;
};

// The keyboard route for what drag-and-drop does with the mouse. Native
// radios: arrows move between groups, Tab reaches the buttons
export const MoveToGroupDialog = ({ database, title, excludeId, currentParentId, onChoose, onCancel }: MoveToGroupDialogProps) => {
    const rows = useMemo(() => flatten(database.root, 0, excludeId, []), [database, excludeId]);
    const [query, setQuery] = useState('');
    const shown = query.trim()
        ? rows.filter((r) => r.group.name.toLowerCase().includes(query.trim().toLowerCase()))
        : rows;
    // Starts on the current group, focused, so the arrows pick from there
    const [selectedId, setSelectedId] = useState<string | null>(
        () => (rows.some((r) => r.group.id === currentParentId) ? currentParentId! : rows[0]?.group.id ?? null)
    );
    const selected = rows.find((r) => r.group.id === selectedId)?.group ?? null;
    const canMove = selected !== null && selected.id !== currentParentId;
    const initialRadio = useRef<HTMLInputElement>(null);

    return (
        <Modal
            overlayClassName="pairing-overlay"
            className="pairing-dialog passkey-dialog move-dialog"
            labelledBy="move-title"
            onClose={onCancel}
            initialFocus={initialRadio}
        >
            <h3 id="move-title">{title}</h3>
            <input
                type="text"
                className="pairing-name-input"
                placeholder="Filter groups"
                aria-label="Filter groups"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <div className="passkey-entry-list move-group-list" role="radiogroup" aria-label="Destination group">
                {shown.map(({ group, level }) => (
                    <label
                        key={group.id}
                        className="passkey-entry-row"
                        style={{ paddingLeft: `${0.6 + level * 1.1}rem` }}
                    >
                        <input
                            type="radio"
                            name="move-target"
                            ref={selectedId === group.id ? initialRadio : undefined}
                            checked={selectedId === group.id}
                            onChange={() => setSelectedId(group.id)}
                            onDoubleClick={() => { if (group.id !== currentParentId) onChoose(group); }}
                        />
                        <span className="passkey-entry-title">{group.name}</span>
                        {group.id === currentParentId && <span className="passkey-entry-username">current</span>}
                    </label>
                ))}
                {shown.length === 0 && <p className="move-group-empty">No group matches</p>}
            </div>
            <div className="pairing-actions">
                <button className="pairing-cancel-button" onClick={onCancel}>Cancel</button>
                <button
                    className="pairing-allow-button"
                    disabled={!canMove}
                    onClick={() => { if (selected) onChoose(selected); }}
                >
                    Move
                </button>
            </div>
        </Modal>
    );
};

// The group holding an entry, for the "current" mark
export const parentGroupOf = (root: Group, entryId: string): Group | null => {
    if (root.entries.some((e) => e.id === entryId)) return root;
    for (const child of root.groups) {
        const found = parentGroupOf(child, entryId);
        if (found) return found;
    }
    return null;
};

// The group holding a subgroup, for the "current" mark
export const parentOfGroup = (root: Group, groupId: string): Group | null => {
    if (root.groups.some((g) => g.id === groupId)) return root;
    for (const child of root.groups) {
        const found = parentOfGroup(child, groupId);
        if (found) return found;
    }
    return null;
};

// Keyboard shortcuts, in one place so the handlers and the table in
// Settings > Info cannot drift apart. A chord is written with Mod for the
// platform's command key: Cmd on macOS, Ctrl elsewhere.

export const isMac = (): boolean => navigator.userAgent.includes('Mac');

export interface ShortcutRow {
    chord: string;
    label: string;
}

export interface ShortcutGroup {
    title: string;
    rows: ShortcutRow[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
    {
        title: 'Vault',
        rows: [
            { chord: 'Mod+F', label: 'Search' },
            { chord: 'Mod+N', label: 'New entry in the current group' },
            { chord: 'Mod+L', label: 'Lock' },
            { chord: 'Mod+,', label: 'Settings' },
            { chord: 'F6', label: 'Next pane (groups, entries, details)' },
            { chord: 'Shift+F6', label: 'Previous pane' },
            { chord: 'Mod+=', label: 'Zoom in' },
            { chord: 'Mod+-', label: 'Zoom out' },
            { chord: 'Mod+0', label: 'Reset zoom' },
        ],
    },
    {
        title: 'Selected entry',
        rows: [
            { chord: 'Mod+C', label: 'Copy password' },
            { chord: 'Mod+B', label: 'Copy username' },
            { chord: 'Mod+T', label: 'Copy one-time code' },
            { chord: 'Mod+U', label: 'Open URL' },
            { chord: 'Mod+E', label: 'Edit' },
            { chord: 'Enter', label: 'Open the details panel (from the list)' },
            { chord: 'Delete', label: 'Remove (from the list)' },
            { chord: 'Escape', label: 'Back to the list (from the details panel)' },
        ],
    },
    {
        title: 'Editing an entry',
        rows: [
            { chord: 'Mod+Enter', label: 'Save' },
        ],
    },
    {
        title: 'Groups',
        rows: [
            { chord: 'Up / Down', label: 'Move between groups' },
            { chord: 'Left / Right', label: 'Collapse or expand, move to parent or child' },
            { chord: 'F2', label: 'Rename' },
            { chord: 'Insert', label: 'New subgroup' },
            { chord: 'Delete', label: 'Remove' },
        ],
    },
];

// The keys of a chord as shown to the user, e.g. ['Ctrl', 'F'] or ['Cmd', 'F']
export const chordKeys = (chord: string): string[] =>
    chord.split('+').map((k) => (k === 'Mod' ? (isMac() ? 'Cmd' : 'Ctrl') : k));

const KEY_ALIASES: Record<string, string> = { Delete: 'Delete', Enter: 'Enter', Escape: 'Escape' };

// Whether a keydown is exactly this chord: the listed modifiers and no
// others, so Mod+Shift+F never passes for Mod+F
export const matchesChord = (e: KeyboardEvent, chord: string): boolean => {
    const parts = chord.split('+');
    const key = parts[parts.length - 1];
    const wantMod = parts.includes('Mod');
    const wantShift = parts.includes('Shift');
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    const other = isMac() ? e.ctrlKey : e.metaKey;
    if (mod !== wantMod || e.shiftKey !== wantShift || e.altKey || other) return false;
    const expected = KEY_ALIASES[key] ?? key;
    return expected.length === 1 ? e.key.toLowerCase() === expected.toLowerCase() : e.key === expected;
};

export type ZoomDirection = 'in' | 'out' | 'reset';

// Mod with plus (shifted or not, main row or numpad), minus or zero
export const zoomAction = (e: KeyboardEvent): ZoomDirection | null => {
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return null;
    if (e.key === '=' || e.key === '+') return 'in';
    if (e.shiftKey) return null;
    if (e.key === '-') return 'out';
    if (e.key === '0') return 'reset';
    return null;
};

// A dialog's focus trap owns the keyboard; vault shortcuts stay out
export const dialogOpen = (): boolean =>
    document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;

export const SEARCH_INPUT_ID = 'vault-search';

export const focusSearch = (): void => {
    const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
    input?.focus();
    input?.select();
};

export const focusEntryGrid = (): void => {
    document.querySelector<HTMLElement>('[role="grid"]')?.focus();
};

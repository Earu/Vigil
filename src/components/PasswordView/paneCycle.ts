// F6 moves keyboard focus between the vault's panes (tree, entry list,
// details), the way browsers, editors and file managers do. Each pane's
// landing element keeps the user's place: the tree's current row, the grid
// itself (its active row is remembered), the details panel.

const PANE_SELECTOR = '.sidebar, .entry-list, .entry-details';

export const isPaneCycleKey = (e: KeyboardEvent): boolean =>
    e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey;

// Landing elements in pane order, absent panes left out
export const paneTargets = (root: ParentNode): HTMLElement[] => [
    root.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'),
    root.querySelector<HTMLElement>('[role="grid"]'),
    root.querySelector<HTMLElement>('.entry-details'),
].filter((el): el is HTMLElement => el !== null);

// The next pane's landing element after the one holding focus. From outside
// every pane (the title bar) it is the first pane
export const nextPane = (targets: HTMLElement[], active: Element | null, backwards: boolean): HTMLElement | null => {
    if (targets.length === 0) return null;
    const activePane = active?.closest(PANE_SELECTOR) ?? null;
    const current = activePane ? targets.findIndex((t) => t.closest(PANE_SELECTOR) === activePane) : -1;
    if (current < 0) return targets[backwards ? targets.length - 1 : 0];
    return targets[(current + (backwards ? -1 : 1) + targets.length) % targets.length];
};

// Wires F6 / Shift+F6 on the window while a vault is open. Ignored while a
// dialog is up: its focus trap owns the keyboard
export const installPaneCycle = (root: () => ParentNode | null): (() => void) => {
    const onKeyDown = (e: KeyboardEvent) => {
        if (!isPaneCycleKey(e)) return;
        const node = root();
        if (!node || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        const target = nextPane(paneTargets(node), document.activeElement, e.shiftKey);
        if (!target) return;
        e.preventDefault();
        target.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
};

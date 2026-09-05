import React from 'react';

interface TabStripProps<T extends string> {
    // Prefix for the tab and panel ids, e.g. 'settings'
    idPrefix: string;
    label: string;
    tabs: Array<{ id: T; label: React.ReactNode }>;
    active: T;
    onChange: (id: T) => void;
    // The existing strip and tab classes; 'active' is appended to the tab
    className: string;
    tabClassName: string;
}

export const tabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
export const panelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

// Spread onto the element that shows the active tab's content
export const tabPanelProps = (idPrefix: string, id: string) => ({
    role: 'tabpanel' as const,
    id: panelId(idPrefix, id),
    'aria-labelledby': tabId(idPrefix, id),
});

// Arrow keys move and activate at once: every panel is cheap to render and
// that is how native tab bars behave
export const TabStrip = <T extends string>({ idPrefix, label, tabs, active, onChange, className, tabClassName }: TabStripProps<T>) => {
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const index = tabs.findIndex((t) => t.id === active);
        let next: number;
        switch (e.key) {
            case 'ArrowRight': next = (index + 1) % tabs.length; break;
            case 'ArrowLeft': next = (index - 1 + tabs.length) % tabs.length; break;
            case 'Home': next = 0; break;
            case 'End': next = tabs.length - 1; break;
            default: return;
        }
        e.preventDefault();
        const target = tabs[next];
        onChange(target.id);
        document.getElementById(tabId(idPrefix, target.id))?.focus();
    };

    return (
        <div role="tablist" aria-label={label} className={className} onKeyDown={onKeyDown}>
            {tabs.map((tab) => {
                const selected = tab.id === active;
                return (
                    <button
                        key={tab.id}
                        role="tab"
                        id={tabId(idPrefix, tab.id)}
                        aria-selected={selected}
                        aria-controls={panelId(idPrefix, tab.id)}
                        tabIndex={selected ? 0 : -1}
                        className={`${tabClassName} ${selected ? 'active' : ''}`}
                        onClick={() => onChange(tab.id)}
                        type="button"
                    >
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
};

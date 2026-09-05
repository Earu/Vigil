import axe from 'axe-core';

// jsdom has no layout, so rules that need geometry or colour are off. The
// page-level rules are off because a test renders one component, not a page.
// axe rejects when two runs overlap, so callers must await each call.
const DISABLED = [
    'color-contrast',
    'region',
    'landmark-one-main',
    'page-has-heading-one',
    'bypass',
    'scrollable-region-focusable',
];

export async function expectNoA11yViolations(root: Element, extraDisabled: string[] = []): Promise<void> {
    const rules = Object.fromEntries([...DISABLED, ...extraDisabled].map((id) => [id, { enabled: false }]));
    const results = await axe.run(root, { rules, resultTypes: ['violations'] });
    if (results.violations.length === 0) return;
    const lines = results.violations.map((v) =>
        `${v.id}: ${v.help}\n` + v.nodes.map((n) => `  ${n.target.join(' ')}\n    ${n.failureSummary}`).join('\n')
    );
    throw new Error(`axe violations:\n${lines.join('\n')}`);
}

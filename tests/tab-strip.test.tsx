// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React, { useState } from 'react';
import { TabStrip, tabPanelProps } from '../src/components/TabStrip';
import { expectNoA11yViolations } from './a11y';

// The three tab strips (settings, generator, security report) share this.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

type Tab = 'one' | 'two' | 'three';
const TABS = [{ id: 'one' as Tab, label: 'One' }, { id: 'two' as Tab, label: 'Two' }, { id: 'three' as Tab, label: 'Three' }];

const Harness = () => {
    const [active, setActive] = useState<Tab>('one');
    return (
        <div>
            <TabStrip idPrefix="t" label="Sections" tabs={TABS} active={active} onChange={setActive} className="strip" tabClassName="tab" />
            <div {...tabPanelProps('t', active)}>{active}</div>
        </div>
    );
};

const tab = (getByRole: any, name: string) => getByRole('tab', { name }) as HTMLButtonElement;

describe('a tab strip', () => {
    it('exposes tabs, selection and the panel', async () => {
        const { getByRole, container } = render(<Harness />);
        expect(getByRole('tablist', { name: 'Sections' })).toBeTruthy();
        expect(tab(getByRole, 'One').getAttribute('aria-selected')).toBe('true');
        expect(tab(getByRole, 'Two').getAttribute('aria-selected')).toBe('false');
        expect(tab(getByRole, 'One').tabIndex).toBe(0);
        expect(tab(getByRole, 'Two').tabIndex).toBe(-1);
        expect(getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab(getByRole, 'One').id);
        await expectNoA11yViolations(container);
    });

    it('moves and activates with arrows, wrapping, and Home/End', () => {
        const { getByRole, getByText } = render(<Harness />);
        const one = tab(getByRole, 'One');
        one.focus();
        fireEvent.keyDown(one, { key: 'ArrowLeft' });
        expect(tab(getByRole, 'Three').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tab(getByRole, 'Three'));
        expect(getByText('three')).toBeTruthy();
        fireEvent.keyDown(tab(getByRole, 'Three'), { key: 'ArrowRight' });
        expect(tab(getByRole, 'One').getAttribute('aria-selected')).toBe('true');
        fireEvent.keyDown(tab(getByRole, 'One'), { key: 'End' });
        expect(document.activeElement).toBe(tab(getByRole, 'Three'));
        fireEvent.keyDown(tab(getByRole, 'Three'), { key: 'Home' });
        expect(document.activeElement).toBe(tab(getByRole, 'One'));
    });

    it('activates on click', () => {
        const { getByRole } = render(<Harness />);
        fireEvent.click(tab(getByRole, 'Two'));
        expect(tab(getByRole, 'Two').getAttribute('aria-selected')).toBe('true');
        expect(tab(getByRole, 'Two').tabIndex).toBe(0);
    });
});

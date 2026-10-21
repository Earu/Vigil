// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { SettingRow, Toggle } from '../src/components/Settings/SettingRow';
import { expectNoA11yViolations } from './a11y';

afterEach(cleanup);

describe('a toggle setting', () => {
    it('is a labelled switch described by its help text', async () => {
        const onChange = vi.fn();
        const { getByRole, container } = render(
            <SettingRow label="Fetch website icons" htmlFor="icons" help="Sends the domain to Google">
                <Toggle id="icons" checked={false} onChange={onChange} />
            </SettingRow>
        );
        const toggle = getByRole('switch', { name: 'Fetch website icons', description: 'Sends the domain to Google' });
        fireEvent.click(toggle);
        expect(onChange).toHaveBeenCalledWith(true);
        await expectNoA11yViolations(container);
    });
});

// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { EntryDetails } from '../src/components/PasswordView/EntryDetails';
import { Entry } from '../src/types/database';
import { expectNoA11yViolations } from './a11y';

// A HOTP code is stored state: generating one moves the counter and saves the
// entry from view mode. That save refreshes the same entry, and the code the
// user just asked for must survive it. The code on screen is always the one
// made from the value before the counter, so a step back undoes a step forward
// exactly and the two stay in sync with the service. Neither step touches the
// clipboard: that is
// the copy button's job, and it is disabled until a code exists. An otp field
// that does not parse must stay visible rather than vanish behind the
// dedicated OTP UI.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
});

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const hotpUri = (counter: number) => `otpauth://hotp/Demo?secret=${SECRET}&counter=${counter}`;

function makeEntry(id: string, otp: string | null): Entry {
    return {
        id, title: 'Demo', username: 'user', password: 'pw',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: otp === null ? [] : [{ key: 'otp', value: otp, protected: true }],
        tags: [],
    };
}

const GENERATE = 'Generate the next code and advance the counter';
const BACK = 'Go back to the previous code and rewind the counter';
const COPY = 'Copy one-time code';

const codeText = (container: HTMLElement) =>
    container.querySelector('.totp-code')?.textContent?.replace(/\s/g, '') ?? null;

const counterOf = (entry: Entry) =>
    new URLSearchParams(String(entry.customFields[0].value).split('?')[1]).get('counter');

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('an otp field that does not parse', () => {
    it('is listed as a plain custom field', () => {
        const { getByText } = render(
            <EntryDetails entry={makeEntry('id-a', 'broken 0189')} onClose={() => {}} onSave={() => {}} />
        );
        expect(getByText('otp')).toBeTruthy();
    });
});

describe('a HOTP entry in view mode', () => {
    it('hides the otp field and shows the counter with no code', async () => {
        const { queryByText, getByText, getByTitle, getByLabelText, container } = render(
            <EntryDetails entry={makeEntry('id-a', hotpUri(0))} onClose={() => {}} onSave={() => {}} />
        );
        expect(queryByText('otp')).toBeNull();
        expect(getByText('#0')).toBeTruthy();
        expect(getByTitle(GENERATE)).toBeTruthy();
        // Nothing to copy, and counter 0 has nothing to step back to
        expect((getByTitle(COPY) as HTMLButtonElement).disabled).toBe(true);
        expect((getByTitle(BACK) as HTMLButtonElement).disabled).toBe(true);
        expect(codeText(container)).toBeNull();
        expect(getByLabelText('Username')).toBeTruthy();
        await expectNoA11yViolations(container);
    });

    it('generates, saves the advanced counter and keeps the code through the refresh', async () => {
        const onSave = vi.fn();
        const { getByTitle, getByText, container, rerender } = render(
            <EntryDetails entry={makeEntry('id-a', hotpUri(0))} onClose={() => {}} onSave={onSave} />
        );

        fireEvent.click(getByTitle(GENERATE));
        // RFC 4226 vector for counter 0
        await waitFor(() => expect(codeText(container)).toBe('755224'));
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(onSave).toHaveBeenCalledTimes(1);
        const saved: Entry = onSave.mock.calls[0][0];
        expect(counterOf(saved)).toBe('1');
        expect(getByText('#1')).toBeTruthy();

        // The save rebuilt the model: same id, new object
        rerender(<EntryDetails entry={makeEntry('id-a', hotpUri(1))} onClose={() => {}} onSave={onSave} />);
        expect(codeText(container)).toBe('755224');
        expect(getByText('#1')).toBeTruthy();

        // The next click uses the advanced counter
        fireEvent.click(getByTitle(GENERATE));
        await waitFor(() => expect(codeText(container)).toBe('287082'));
        expect(counterOf(onSave.mock.calls[1][0])).toBe('2');

        // The copy button is the only thing that reaches the clipboard
        fireEvent.click(getByTitle(COPY));
        await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('287082'));
    });

    it('steps back to the previous code, undoing a step forward exactly', async () => {
        const onSave = vi.fn();
        const { getByTitle, getByText, container } = render(
            <EntryDetails entry={makeEntry('id-a', hotpUri(1))} onClose={() => {}} onSave={onSave} />
        );

        fireEvent.click(getByTitle(GENERATE));
        await waitFor(() => expect(codeText(container)).toBe('287082'));
        expect(getByText('#2')).toBeTruthy();

        // One step back is the code before it, and the counter follows, so a
        // service that took 755224 is now expecting exactly #1
        fireEvent.click(getByTitle(BACK));
        await waitFor(() => expect(codeText(container)).toBe('755224'));
        expect(getByText('#1')).toBeTruthy();
        expect(counterOf(onSave.mock.calls[1][0])).toBe('1');

        // Forward again lands back on the code the step forward gave
        fireEvent.click(getByTitle(GENERATE));
        await waitFor(() => expect(codeText(container)).toBe('287082'));
        expect(getByText('#2')).toBeTruthy();
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('has no code left below counter 1 and stops at zero', async () => {
        const onSave = vi.fn();
        const { getByTitle, getByText, container } = render(
            <EntryDetails entry={makeEntry('id-a', hotpUri(1))} onClose={() => {}} onSave={onSave} />
        );

        // #1 means counter 0 was consumed, so back shows nothing was
        fireEvent.click(getByTitle(BACK));
        await waitFor(() => expect(getByText('#0')).toBeTruthy());
        expect(codeText(container)).toBeNull();
        expect(counterOf(onSave.mock.calls[0][0])).toBe('0');
        expect((getByTitle(BACK) as HTMLButtonElement).disabled).toBe(true);
        expect((getByTitle(COPY) as HTMLButtonElement).disabled).toBe(true);
    });

    it('drops the code when another entry is selected', async () => {
        const { getByTitle, container, rerender } = render(
            <EntryDetails entry={makeEntry('id-a', hotpUri(0))} onClose={() => {}} onSave={() => {}} />
        );
        fireEvent.click(getByTitle(GENERATE));
        await waitFor(() => expect(codeText(container)).toBe('755224'));

        rerender(<EntryDetails entry={makeEntry('id-b', hotpUri(4))} onClose={() => {}} onSave={() => {}} />);
        expect(codeText(container)).toBeNull();
        expect(container.textContent).toContain('#4');
    });

    it('drops the code on entering edit mode and lets the counter be resynced', async () => {
        const onSave = vi.fn();
        const { getByTitle, getByText, container } = render(
            <EntryDetails entry={makeEntry('id-a', hotpUri(0))} onClose={() => {}} onSave={onSave} />
        );
        fireEvent.click(getByTitle(GENERATE));
        await waitFor(() => expect(codeText(container)).toBe('755224'));

        fireEvent.click(getByTitle('Edit entry'));
        expect(codeText(container)).toBeNull();
        const counterInput = container.querySelector('.hotp-counter-input') as HTMLInputElement;
        expect(counterInput.value).toBe('1');

        fireEvent.change(counterInput, { target: { value: '12' } });
        fireEvent.click(getByText('Save'));
        const saved: Entry = onSave.mock.calls[onSave.mock.calls.length - 1][0];
        expect(counterOf(saved)).toBe('12');
    });
});

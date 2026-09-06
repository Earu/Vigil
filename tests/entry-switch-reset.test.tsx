// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { EntryDetails } from '../src/components/PasswordView/EntryDetails';
import { Entry } from '../src/types/database';

// Panel state belongs to the entry it was produced on. Selecting another
// entry re-seeds the form, so anything left behind is describing, or worse
// writing to, a vault object that is no longer on screen.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Enough of a Google Authenticator export to raise the account picker: two
// accounts in one QR is what makes it ask which one this entry gets
const varint = (n: number): number[] => {
    const out: number[] = [];
    do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
    return out;
};
const lenField = (f: number, b: number[]): number[] => [(f << 3) | 2, ...varint(b.length), ...b];
const varField = (f: number, v: number): number[] => [f << 3, ...varint(v)];
const seed = Array.from('12345678901234567890', c => c.charCodeAt(0));
const account = (name: string) => lenField(1, [
    ...lenField(1, seed),
    ...lenField(2, Array.from(new TextEncoder().encode(name))),
    ...varField(6, 2),
]);
const TWO_ACCOUNT_QR = 'otpauth-migration://offline?data=' + encodeURIComponent(
    btoa(String.fromCharCode(...[...account('one'), ...account('two'), ...varField(2, 1), ...varField(3, 1), ...varField(4, 0)])));

const makeEntry = (id: string): Entry => ({
    id, title: id, username: 'user', password: 'pw',
    created: new Date(), modified: new Date(),
    attachments: [], history: [], expires: false, customFields: [], tags: [],
});

afterEach(() => { cleanup(); vi.clearAllMocks(); delete (window as any).electron; });

describe('switching entries', () => {
    // The picker is a modal rendered outside the edit-mode blocks, so it
    // survived a selection change; confirming it then wrote the one-time-code
    // secret scanned for the previous entry onto the one now on screen
    it('closes the Google Authenticator account picker', async () => {
        (window as any).electron = {
            qrCaptureScreens: vi.fn(async () => ({ success: true, text: TWO_ACCOUNT_QR })),
        };
        const saved: Entry[] = [];
        const { getByTitle, queryByText, rerender } = render(
            <EntryDetails entry={makeEntry('a')} onClose={() => {}} onSave={(e) => saved.push(e)} />
        );
        fireEvent.click(getByTitle('Edit entry'));
        fireEvent.click(getByTitle(/Scan a QR code shown on your screen/));
        await waitFor(() => expect(queryByText('Choose an account')).toBeTruthy());

        rerender(<EntryDetails entry={makeEntry('b')} onClose={() => {}} onSave={(e) => saved.push(e)} />);
        expect(queryByText('Choose an account')).toBeNull();
    });
});

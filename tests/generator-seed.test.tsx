// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { PasswordGenerator } from '../src/components/PasswordView/PasswordGenerator';
import { PasswordGeneratorService } from '../src/services/PasswordGeneratorService';

// Opening the generator on an entry seeds it with that password's shape, and
// an entry can hold one longer than the generator's own maximum: an imported
// API token, an SSH key passphrase. The seed runs through generate() in a
// mount effect, so a length it refuses used to throw with nothing above to
// catch it, taking the window down along with the open entry.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const openOn = (currentPassword: string) =>
    render(<PasswordGenerator onClose={() => {}} onSave={() => {}} currentPassword={currentPassword} />);

describe('generator seeded from an existing password', () => {
    it('opens on a password longer than the maximum', () => {
        const long = 'Aa1!'.repeat(40);
        expect(long.length).toBeGreaterThan(PasswordGeneratorService.MAX_LENGTH);
        expect(() => openOn(long)).not.toThrow();
    });

    it('clamps the seeded length to the maximum', () => {
        const { container } = openOn('Aa1!'.repeat(40));
        const length = container.querySelector('#generator-length') as HTMLInputElement;
        expect(length.value).toBe(String(PasswordGeneratorService.MAX_LENGTH));
    });

    it('keeps an ordinary password length', () => {
        const { container } = openOn('Aa1!Aa1!Aa1!');
        const length = container.querySelector('#generator-length') as HTMLInputElement;
        expect(length.value).toBe('12');
    });
});

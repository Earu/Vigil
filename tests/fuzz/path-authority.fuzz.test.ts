import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { settings, anyText, anyValue } from './fuzz';

// The path authority is what turns "the renderer can call read-file" into
// "the renderer can read the vault it opened and nothing else". A grant for
// one path must never answer for another, however the other is spelled

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-fuzz-paths-'));
vi.mock('electron', () => ({
    app: { getPath: () => userData },
    dialog: {},
    shell: {},
    BrowserWindow: {},
}));

const authority = await import('../../electron/src/path-authority');

const segment = fc.stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/).filter(s => s !== '.' && s !== '..');
const absolutePath = fc.array(segment, { minLength: 1, maxLength: 5 }).map(parts => '/' + parts.join('/'));

beforeEach(() => {
    authority.resetForTests();
    fs.rmSync(path.join(userData, 'granted-paths.json'), { force: true });
});

describe('path authority under fuzz', () => {
    it('a grant answers for its own path and for nothing that merely resembles it', () => {
        fc.assert(fc.property(absolutePath, segment, (granted, extra) => {
            authority.resetForTests();
            authority.grantPath(granted);
            expect(authority.isPathGranted(granted)).toBe(true);
            expect(authority.isPathGranted(granted + '/' + extra)).toBe(false);
            expect(authority.isPathGranted(granted + extra)).toBe(false);
            expect(authority.isPathGranted(path.dirname(granted))).toBe(granted === path.dirname(granted));
            expect(authority.isPathGranted(granted, { write: true })).toBe(false);
        }), settings());
    });

    it('two distinct paths never vouch for each other', () => {
        fc.assert(fc.property(absolutePath, absolutePath, (a, b) => {
            fc.pre(path.resolve(a) !== path.resolve(b));
            authority.resetForTests();
            authority.grantPath(a, { write: true });
            expect(authority.isPathGranted(b)).toBe(false);
            expect(authority.isPathGranted(b, { write: true })).toBe(false);
        }), settings());
    });

    it('a traversal spelling of a granted path is the same grant, not an escape', () => {
        fc.assert(fc.property(absolutePath, segment, (granted, decoy) => {
            // A decoy named like the granted file is the granted file
            fc.pre(decoy !== path.basename(granted));
            authority.resetForTests();
            authority.grantPath(granted);
            const spelled = `${path.dirname(granted)}/${decoy}/../${path.basename(granted)}`;
            expect(authority.isPathGranted(spelled)).toBe(true);
            // ..and it still says nothing about the decoy itself
            expect(authority.isPathGranted(`${path.dirname(granted)}/${decoy}`)).toBe(false);
        }), settings());
    });

    it('answers false, never throws, for anything that is not a path string', () => {
        fc.assert(fc.property(anyValue(), (value) => {
            fc.pre(typeof value !== 'string');
            expect(authority.isPathGranted(value)).toBe(false);
            expect(authority.isPathGranted(value, { write: true })).toBe(false);
        }), settings());
    });

    it('never throws for any string, granted or not', () => {
        fc.assert(fc.property(anyText(), (text) => {
            expect(authority.isPathGranted(text)).toBe(false);
        }), settings());
    });

    it('a persistent grant survives a restart with the same rights and no more', () => {
        fc.assert(fc.property(absolutePath, fc.boolean(), (granted, write) => {
            authority.resetForTests();
            fs.rmSync(path.join(userData, 'granted-paths.json'), { force: true });
            authority.grantPathPersistent(granted, { write });
            authority.resetForTests();
            expect(authority.isPathGranted(granted)).toBe(true);
            expect(authority.isPathGranted(granted, { write: true })).toBe(write);
        }), settings({ numRuns: Math.min(50, settings().numRuns!) }));
    });
});

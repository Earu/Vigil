import { describe, it, expect } from 'vitest';
import { installMockWindow } from './helpers';
import type { Entry } from '../src/types/database';

installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

const entry = (over: Partial<Entry>): Entry => ({ ...Svc.createNewEntry(), id: over.title ?? 'x', ...over });

const github = entry({
    title: 'GitHub', username: 'earu', url: 'https://github.com',
    notes: 'personal account', tags: ['dev', 'home lab'],
});
const router = entry({
    title: 'Router admin', username: 'admin', url: 'http://192.168.1.1',
    tags: ['network'],
    customFields: [
        { key: 'Serial', value: 'SN-4471', protected: false },
        { key: 'Recovery Key', value: 'topsecret', protected: true },
    ],
});
const mail = entry({ title: 'Mail', username: 'earu@example.com', tags: ['Dev'] });
// title and username hold the two words of "router admin" separately, which is
// what a phrase search has to reject and a two-term search has to accept
const console_ = entry({ title: 'Admin console', username: 'router' });
const nas = entry({ title: 'NAS', tags: ['home'] });

const all = [github, router, mail, console_, nas];
const found = (query: string) => Svc.filterEntries(all, query).map(e => e.title);

describe('search', () => {
    it('matches the standard fields, as it always did', () => {
        expect(found('github')).toEqual(['GitHub']);
        expect(found('admin')).toEqual(['Router admin', 'Admin console']);
        expect(found('192.168')).toEqual(['Router admin']);
        expect(found('personal')).toEqual(['GitHub']);
    });

    it('requires every term to match', () => {
        expect(found('router github')).toEqual([]);
        expect(found('admin console')).toEqual(['Admin console']);
    });

    it('reaches tags and custom field names', () => {
        expect(found('network')).toEqual(['Router admin']);
        expect(found('serial')).toEqual(['Router admin']);
        expect(found('SN-4471')).toEqual(['Router admin']);
    });

    it('leaves protected field values out of a bare search', () => {
        // the field name is findable, the secret behind it is not
        expect(found('recovery')).toEqual(['Router admin']);
        expect(found('topsecret')).toEqual([]);
    });

    it('scopes a term to one field with a prefix', () => {
        expect(found('title:mail')).toEqual(['Mail']);
        // 'earu' is a username here and part of a note nowhere else
        expect(found('user:earu')).toEqual(['GitHub', 'Mail']);
        expect(found('url:github')).toEqual(['GitHub']);
        expect(found('notes:personal')).toEqual(['GitHub']);
        // title: does not leak into the username
        expect(found('title:admin')).toEqual(['Router admin', 'Admin console']);
        expect(found('title:earu')).toEqual([]);
    });

    it('filters by tag, case-insensitively', () => {
        expect(found('tag:dev')).toEqual(['GitHub', 'Mail']);
        expect(found('tag:DEV')).toEqual(['GitHub', 'Mail']);
        expect(found('tag:network')).toEqual(['Router admin']);
    });

    it('keeps a quoted phrase together', () => {
        // two terms: both words present anywhere, in any field
        expect(found('router admin')).toEqual(['Router admin', 'Admin console']);
        // one phrase: the words have to be adjacent in the same field
        expect(found('"router admin"')).toEqual(['Router admin']);
    });

    it('targets a multi-word tag exactly when quoted', () => {
        expect(found('tag:"home lab"')).toEqual(['GitHub']);
        // unquoted this is a substring of both tags
        expect(found('tag:home')).toEqual(['GitHub', 'NAS']);
    });

    it('combines a scoped term with a bare one', () => {
        expect(found('tag:dev github')).toEqual(['GitHub']);
        expect(found('tag:dev router')).toEqual([]);
    });

    it('treats an unknown prefix as a plain term, so a pasted URL still works', () => {
        expect(found('https://github.com')).toEqual(['GitHub']);
        expect(found('nosuchfield:github')).toEqual([]);
    });

    it('returns everything for an empty or whitespace query', () => {
        expect(found('')).toHaveLength(all.length);
        expect(found('   ')).toHaveLength(all.length);
    });
});

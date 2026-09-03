import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';
import { Entry, Group } from '../src/types/database';

installMockWindow();
const { PlaceholderService } = await import('../src/services/PlaceholderService');

// KeePass field references and placeholders. KeePassXC is the reference:
// {REF:<Wanted>@<SearchIn>:<Text>} finds the first entry whose SearchIn
// field contains Text and yields its Wanted field, resolved in the found
// entry's own context; local placeholders resolve against the entry they
// sit in; anything unknown passes through byte for byte.

const uuidA = kdbxweb.KdbxUuid.random();
const uuidHexA = [...kdbxweb.ByteUtils.base64ToBytes(uuidA.id)]
    .map(b => b.toString(16).padStart(2, '0')).join('');

function makeEntry(over: Partial<Entry>): Entry {
    return {
        id: kdbxweb.KdbxUuid.random().toString(),
        title: '', username: '', password: '',
        created: new Date(), modified: new Date(),
        attachments: [], history: [], expires: false,
        customFields: [], tags: [],
        ...over,
    };
}

function makeRoot(entries: Entry[], subEntries: Entry[] = []): Group {
    const sub: Group = { id: 'sub', name: 'Sub', groups: [], entries: subEntries };
    return { id: 'root', name: 'Root', groups: [sub], entries };
}

describe('model placeholder resolution', () => {
    const target = makeEntry({
        id: uuidA.toString(),
        title: 'Mail Account',
        username: 'alice@example.com',
        password: 'secret-mail-pw',
        url: 'https://mail.example.com',
        customFields: [{ key: 'PIN', value: '4321', protected: false }],
    });

    it('leaves plain text alone', () => {
        const root = makeRoot([target]);
        expect(PlaceholderService.resolveModel('nothing here', target, root)).toBe('nothing here');
    });

    it('resolves local placeholders against the entry itself', () => {
        const entry = makeEntry({ title: 'Site', username: 'bob', notes: 'user is {USERNAME} on {TITLE}' });
        const root = makeRoot([entry]);
        expect(PlaceholderService.resolveModel(entry.notes!, entry, root))
            .toBe('user is bob on Site');
    });

    it('resolves {S:...} custom fields case-insensitively', () => {
        const root = makeRoot([target]);
        expect(PlaceholderService.resolveModel('pin={S:pin}', target, root)).toBe('pin=4321');
    });

    it('resolves references by title match', () => {
        const referrer = makeEntry({ title: 'Alias', password: '{REF:P@T:Mail Account}' });
        const root = makeRoot([referrer], [target]);
        expect(PlaceholderService.resolveModel(referrer.password as string, referrer, root))
            .toBe('secret-mail-pw');
    });

    it('resolves references by uuid, the format KeePassXC writes', () => {
        const referrer = makeEntry({ username: `{REF:U@I:${uuidHexA.toUpperCase()}}` });
        const root = makeRoot([referrer], [target]);
        expect(PlaceholderService.resolveModel(referrer.username, referrer, root))
            .toBe('alice@example.com');
    });

    it('resolves the found entry in its own context, recursively', () => {
        const hub = makeEntry({ title: 'Hub', username: 'hub-user', password: 'pw for {USERNAME}' });
        const referrer = makeEntry({ password: '{REF:P@T:Hub}' });
        const root = makeRoot([referrer, hub]);
        expect(PlaceholderService.resolveModel(referrer.password as string, referrer, root))
            .toBe('pw for hub-user');
    });

    it('stops on reference cycles instead of hanging', () => {
        const a = makeEntry({ title: 'CycleA', username: '{REF:U@T:CycleB}' });
        const b = makeEntry({ title: 'CycleB', username: '{REF:U@T:CycleA}' });
        const root = makeRoot([a, b]);
        const out = PlaceholderService.resolveModel(a.username, a, root);
        expect(out).toContain('{REF:');
    });

    it('leaves unknown tokens and unmatched references untouched', () => {
        const entry = makeEntry({ password: 'literal {braces} and {REF:P@T:No Such Entry}' });
        const root = makeRoot([entry]);
        expect(PlaceholderService.resolveModel(entry.password as string, entry, root))
            .toBe('literal {braces} and {REF:P@T:No Such Entry}');
    });

    it('honours KeePass brace escapes', () => {
        const entry = makeEntry({});
        const root = makeRoot([entry]);
        expect(PlaceholderService.resolveModel('a{{}b{}}c', entry, root)).toBe('a{b}c');
    });

    it('does not search the recycle bin', () => {
        const binned = makeEntry({ title: 'Binned', password: 'gone' });
        const bin: Group = { id: 'bin', name: 'Bin', groups: [], entries: [binned], isRecycleBin: true };
        const referrer = makeEntry({ password: '{REF:P@T:Binned}' });
        const root: Group = { id: 'root', name: 'Root', groups: [bin], entries: [referrer] };
        expect(PlaceholderService.resolveModel(referrer.password as string, referrer, root))
            .toBe('{REF:P@T:Binned}');
    });
});

describe('kdbx placeholder resolution', () => {
    it('resolves references for browser logins straight off the kdbx', () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        db.setVersion(3);
        const root = db.getDefaultGroup();
        const target = db.createEntry(root);
        target.fields.set('Title', 'Origin');
        target.fields.set('Password', kdbxweb.ProtectedValue.fromString('kdbx-pw'));
        const referrer = db.createEntry(root);
        referrer.fields.set('Password', kdbxweb.ProtectedValue.fromString('{REF:P@T:Origin}'));

        const raw = (referrer.fields.get('Password') as kdbxweb.ProtectedValue).getText();
        expect(PlaceholderService.resolveKdbx(raw, referrer, root)).toBe('kdbx-pw');
    });

    it('skips the recycle bin like the model resolver does', () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        db.setVersion(3);
        const root = db.getDefaultGroup();
        const bin = db.createGroup(root, 'Bin');
        const binned = db.createEntry(bin);
        binned.fields.set('Title', 'Origin');
        binned.fields.set('Password', kdbxweb.ProtectedValue.fromString('deleted-pw'));
        const referrer = db.createEntry(root);

        // With the bin uuid passed (as browser autofill does), a reference
        // into deleted material stays unresolved instead of autofilling it
        expect(PlaceholderService.resolveKdbx('{REF:P@T:Origin}', referrer, root, bin.uuid.id))
            .toBe('{REF:P@T:Origin}');
        expect(PlaceholderService.resolveKdbx('{REF:P@T:Origin}', referrer, root))
            .toBe('deleted-pw');
    });
});

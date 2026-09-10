import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { SecretShareService, ShareOptions } from '../src/services/SecretShareService';
import { buildPage, FRAGMENT_BLOB, INLINE_BLOB } from '../src/services/sharePage';
import { Entry } from '../src/types/database';

// The share file is opened by a page Vigil will never run, so these tests open
// it the way that page does: pull the blob back out of the generated HTML and
// decrypt with nothing but what the recipient is given. A test that called the
// service's own internals would pass on a file nobody could open.

const entry = (over: Partial<Entry> = {}): Entry => ({
    id: 'entry-1',
    title: 'staging.example.com',
    username: 'deploy',
    password: kdbxweb.ProtectedValue.fromString('sixteen bananas'),
    url: 'https://staging.example.com',
    notes: 'ssh on 2222',
    created: new Date('2026-01-01T00:00:00Z'),
    modified: new Date('2026-01-01T00:00:00Z'),
    attachments: [],
    history: [],
    customFields: [],
    ...over,
} as Entry);

const options = (over: Partial<ShareOptions> = {}): ShareOptions => ({
    include: ['title', 'username', 'password', 'url', 'notes'],
    recipient: 'Anna',
    senderName: 'Ryan',
    message: 'Change this once you are in.',
    ...over,
});

const html = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// The payload is a flat list the page renders without knowing what any of it
// means, so tests read it the same way
const valueOf = (payload: any, label: string): string | undefined =>
    payload.items.find((item: any) => item.label === label)?.value;
const itemOf = (payload: any, label: string): any =>
    payload.items.find((item: any) => item.label === label);

const blobOf = (page: string): any => {
    const match = page.match(/var BLOB = (\{.*?\});\nvar ALPHABET/s);
    if (!match) throw new Error('No blob in the generated page');
    return JSON.parse(match[1]);
};

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

// The page's own routine, transcribed
const phraseBits = async (blob: any, phrase: string): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey('raw', utf8(phrase), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: bytes(blob.salt), iterations: blob.iterations, hash: 'SHA-256' }, key, 256));
};

const openPayload = async (blob: any, fileKey: Uint8Array): Promise<any> => {
    const aes = await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(blob.iv) }, aes, bytes(blob.data));
    return JSON.parse(new TextDecoder().decode(plain));
};

const openWithCode = async (blob: any, phrase: string, formatted: string): Promise<any> => {
    const tidy = formatted.toUpperCase().replace(/[\s-]/g, '').replace(/[ILU]/g, '1').replace(/O/g, '0');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let index = 0;
    for (const char of tidy.slice(0, 3)) index = index * 32 + alphabet.indexOf(char);
    const code = tidy.slice(3);

    const ikm = new Uint8Array([...await phraseBits(blob, phrase), ...utf8(code)]);
    const hk = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: bytes(blob.salt), info: utf8('vigil-share-wrap-v1') }, hk, 352));
    const wrapKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-GCM', false, ['decrypt']);
    const fileKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: derived.slice(32, 44) }, wrapKey, bytes(blob.wraps[index]));
    return openPayload(blob, new Uint8Array(fileKey));
};

describe('secret share files', () => {
    it('keeps the password and the share secret out of the file', async () => {
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const text = html(page);
        expect(text).not.toContain('sixteen bananas');
        expect(text).not.toContain(share.secret);
        // Nothing to type but the code: the file asks for one field
        expect(text).not.toContain('id="phrase"');
        expect(text).toContain('id="code"');
    });

    it('opens an approved share with the words and the code for the window', async () => {
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const blob = blobOf(html(page));
        const current = await SecretShareService.currentCode(share);
        expect(current).not.toBeNull();

        const secret = await openWithCode(blob, '', current!.code);
        expect(valueOf(secret, 'Password')).toBe('sixteen bananas');
        expect(secret.message).toBe('Change this once you are in.');
    });

    it('accepts a code typed in lower case with spaces', async () => {
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const blob = blobOf(html(page));
        const current = await SecretShareService.currentCode(share);

        const sloppy = current!.code.toLowerCase().replace(/-/g, ' ');
        const secret = await openWithCode(blob, '', sloppy);
        expect(valueOf(secret, 'Password')).toBe('sixteen bananas');
    });

    it('refuses a code from the wrong window', async () => {
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const blob = blobOf(html(page));
        const other = await SecretShareService.codeFor(share.secret, 5, share.schedule!.codeLength);

        await expect(openWithCode(blob, '', SecretShareService.formatCode(0, other))).rejects.toThrow();
    });

    it('opens on nothing but the code, and not on the empty passphrase alone', async () => {
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const blob = blobOf(html(page));
        // The passphrase half of the derivation is a constant now, so the
        // wrap is what stands between the file and its contents
        await expect(openPayload(blob, await phraseBits(blob, ''))).rejects.toThrow();
        const opened = await openWithCode(blob, '', (await SecretShareService.currentCode(share))!.code);
        expect(valueOf(opened, 'Password')).toBe('sixteen bananas');
    });

    it('is one code for one day, counted from when it was made', async () => {
        const before = Date.now();
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const blob = blobOf(html(page));

        expect(share.schedule!.count).toBe(1);
        expect(share.schedule!.windowMs).toBe(SecretShareService.SHARE_MS);
        expect(blob.wraps).toHaveLength(1);
        // Not aligned to a grid: a share made in the evening would otherwise
        // die at midnight
        expect(share.schedule!.start).toBeGreaterThanOrEqual(before);
        expect(SecretShareService.expiresAt(share.schedule!).getTime())
            .toBeGreaterThanOrEqual(before + SecretShareService.SHARE_MS);

        // And nothing answers for the day after, the sender's code included
        expect(blob.wraps[1]).toBeUndefined();
        expect(await SecretShareService.currentCode(share, share.schedule!.start + SecretShareService.SHARE_MS)).toBeNull();
    });

    it('derives the same code for a window every time and a different one per window', async () => {
        const { share } = await SecretShareService.create(entry(), options());
        const first = await SecretShareService.codeFor(share.secret, 7, 15);
        const again = await SecretShareService.codeFor(share.secret, 7, 15);
        const other = await SecretShareService.codeFor(share.secret, 8, 15);

        expect(first).toBe(again);
        expect(first).not.toBe(other);
        expect(first).toHaveLength(15);
        expect(SecretShareService.formatCode(7, first)).toMatch(/^[0-9A-Z]{3}(-[0-9A-Z]{5}){3}$/);
    });

    it('makes a code short enough to read out, and no passphrase', async () => {
        const { share } = await SecretShareService.create(entry(), options());
        expect(share.phrase).toBe('');
        expect(share.schedule!.codeLength).toBe(SecretShareService.CODE_LENGTH);
        expect(share.schedule!.hasPhrase).toBe(false);
        const current = await SecretShareService.currentCode(share);
        expect(current!.code).toMatch(/^[0-9A-Z]{3}(-[0-9A-Z]{5}){3}$/);
    });

    it('still reads a passphrase-only share made before codes were the only way in', async () => {
        // Nothing writes these any more, but they are on entries already
        const stored = [{
            key: SecretShareService.FIELD_KEY,
            value: kdbxweb.ProtectedValue.fromString(JSON.stringify([{
                id: 'old', secret: '', phrase: 'gallon-uphill-cranny-sixfold-anthill-mocking',
                schedule: null, recipient: 'Mary', createdAt: '2026-09-01T00:00:00.000Z',
            }])),
            protected: true,
        }];

        const [read] = SecretShareService.sharesFromFields(stored);
        expect(read).toBeDefined();
        expect(read.phrase).toBe('gallon-uphill-cranny-sixfold-anthill-mocking');
        expect(read.recipient).toBe('Mary');
        expect(await SecretShareService.currentCode(read)).toBeNull();
    });

    it('opens a share that has no words with the code alone', async () => {
        const { html: page, share } = await SecretShareService.create(entry(), options());
        const blob = blobOf(html(page));
        const current = await SecretShareService.currentCode(share);

        const secret = await openWithCode(blob, '', current!.code);
        expect(valueOf(secret, 'Password')).toBe('sixteen bananas');
    });

    it('round-trips a share through the entry fields, protected, in one field', async () => {
        const { share } = await SecretShareService.create(entry(), options());
        const fields = SecretShareService.toFields([share]);

        expect(fields).toHaveLength(1);
        expect(fields[0].key).toBe(SecretShareService.FIELD_KEY);
        expect(fields[0].protected).toBe(true);
        expect(fields[0].value).toBeInstanceOf(kdbxweb.ProtectedValue);

        const [read] = SecretShareService.sharesFromFields(fields);
        expect(read.id).toBe(share.id);
        expect(read.secret).toBe(share.secret);
        expect(read.phrase).toBe(share.phrase);
        expect(read.recipient).toBe('Anna');
        expect(read.schedule).toEqual(share.schedule);
    });

    it('keeps one share per person, in the order they were made', async () => {
        const first = (await SecretShareService.create(entry(), options({ recipient: 'Anna' }))).share;
        const second = (await SecretShareService.create(entry(), options({ recipient: 'Paul' }))).share;

        const read = SecretShareService.sharesFromFields(SecretShareService.toFields([first, second]));
        expect(read.map(s => s.recipient)).toEqual(['Anna', 'Paul']);
        expect(read[0].id).not.toBe(read[1].id);
        expect(read[0].secret).not.toBe(read[1].secret);
        // Each share's codes come from its own secret, so one recipient's code
        // never opens another's file
        expect(await SecretShareService.codeFor(read[0].secret, 0, 15))
            .not.toBe(await SecretShareService.codeFor(read[1].secret, 0, 15));
    });

    it('drops a share by leaving it out, and writes no field when none are left', async () => {
        const { share } = await SecretShareService.create(entry(), options());
        expect(SecretShareService.toFields([])).toEqual([]);
        expect(SecretShareService.sharesFromFields(SecretShareService.toFields([share]).filter(() => false))).toEqual([]);
    });

    it('still reads a share written before an entry could hold more than one', () => {
        const legacy = [
            { key: SecretShareService.LEGACY_FIELD_KEYS.secret, value: kdbxweb.ProtectedValue.fromString('c2VjcmV0'), protected: true },
            { key: SecretShareService.LEGACY_FIELD_KEYS.phrase, value: kdbxweb.ProtectedValue.fromString('six-old-words-right-here-now'), protected: true },
            { key: SecretShareService.LEGACY_FIELD_KEYS.recipient, value: 'Paul', protected: false },
            { key: SecretShareService.LEGACY_FIELD_KEYS.createdAt, value: '2026-09-10T00:00:00.000Z', protected: false },
            { key: SecretShareService.LEGACY_FIELD_KEYS.schedule, value: JSON.stringify({ start: 0, windowMs: 7_200_000, count: 84, codeLength: 15, hasPhrase: true }), protected: false },
        ];

        const [read] = SecretShareService.sharesFromFields(legacy);
        expect(read.recipient).toBe('Paul');
        expect(read.phrase).toBe('six-old-words-right-here-now');
        expect(read.schedule?.count).toBe(84);
        expect(read.id).toBeTruthy();
        // And it is carried into the new field the next time the entry is saved
        expect(SecretShareService.toFields([read])[0].key).toBe(SecretShareService.FIELD_KEY);
        expect(legacy.every(f => SecretShareService.isShareFieldKey(f.key))).toBe(true);
    });

    it('hides its own fields from the entry and gives them back on request', async () => {
        const { share } = await SecretShareService.create(entry(), options());
        const fields = [
            { key: 'Custom', value: 'kept', protected: false },
            ...SecretShareService.toFields([share]),
        ];

        expect(fields.filter(f => SecretShareService.isShareFieldKey(f.key)).length).toBeGreaterThan(0);
        expect(SecretShareService.withoutShareFields(fields)).toEqual([{ key: 'Custom', value: 'kept', protected: false }]);
    });

    it('reads nothing from an entry with no shares, or from a damaged record', () => {
        expect(SecretShareService.sharesFromFields([])).toEqual([]);
        expect(SecretShareService.sharesFromFields([
            { key: SecretShareService.FIELD_KEY, value: 'not json', protected: true },
        ])).toEqual([]);
        // An entry in the list with no secret is not a share
        expect(SecretShareService.sharesFromFields([
            { key: SecretShareService.FIELD_KEY, value: JSON.stringify([{ recipient: 'Anna' }]), protected: true },
        ])).toEqual([]);

        const [damaged] = SecretShareService.sharesFromFields([
            { key: SecretShareService.FIELD_KEY, value: JSON.stringify([{ secret: 'AAAA', schedule: { count: 0 } }]), protected: true },
        ]);
        expect(damaged.schedule).toBeNull();
    });

    it('offers an SSH key as what it is, and never the KeeAgent settings', () => {
        const pem = new TextEncoder().encode('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n');
        const withKey = entry({
            attachments: [
                { name: 'id_ed25519', data: pem.buffer },
                { name: 'KeeAgent.settings', data: new TextEncoder().encode('<xml/>').buffer },
                { name: 'notes.txt', data: new TextEncoder().encode('hello').buffer },
            ],
        });

        const parts = SecretShareService.partsOf(withKey);
        expect(parts.map(p => p.id)).toContain('file:id_ed25519');
        expect(parts.map(p => p.id)).toContain('file:notes.txt');
        expect(parts.map(p => p.id)).not.toContain('file:KeeAgent.settings');
        expect(parts.find(p => p.id === 'file:id_ed25519')?.detail).toMatch(/^SSH key, /);
        expect(parts.find(p => p.id === 'file:notes.txt')?.detail).toBe('5 B');
    });

    it('sends an SSH key whole, so it can be used at the other end', async () => {
        const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n';
        const withKey = entry({ attachments: [{ name: 'id_ed25519', data: new TextEncoder().encode(pem).buffer }] });
        const { html: page, share } = await SecretShareService.create(withKey, options({
            include: ['password', 'file:id_ed25519'],
        }));
        const blob = blobOf(html(page));
        const opened = await openWithCode(blob, '', (await SecretShareService.currentCode(share))!.code);

        const file = itemOf(opened, 'id_ed25519');
        expect(new TextDecoder().decode(bytes(file.data))).toBe(pem);
        // The passphrase for a key lives in the entry's password, so the two
        // travel together when both are ticked
        expect(valueOf(opened, 'Password')).toBe('sixteen bananas');
    });

    it('offers every part of the entry that has something in it', () => {
        const rich = entry({
            notes: '',
            customFields: [
                { key: 'API key', value: kdbxweb.ProtectedValue.fromString('sk-live-1'), protected: true },
                { key: 'Seat', value: '4B', protected: false },
                { key: 'Empty', value: '', protected: false },
                { key: 'otp', value: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=30&digits=6', protected: false },
            ],
            attachments: [{ name: 'report.pdf', data: new ArrayBuffer(2048) }],
        });

        const parts = SecretShareService.partsOf(rich);
        expect(parts.map(p => p.id)).toEqual([
            'title', 'username', 'password', 'url', 'otp', 'field:API key', 'field:Seat', 'file:report.pdf',
        ]);
        // Empty notes and an empty field are not offered, the one-time code is
        // not listed as a custom field, and the protected one is a secret
        expect(parts.find(p => p.id === 'field:API key')?.kind).toBe('secret');
        expect(parts.find(p => p.id === 'field:Seat')?.kind).toBe('text');
        expect(parts.find(p => p.id === 'file:report.pdf')?.detail).toBe('2.0 KB');
        expect(SecretShareService.defaultSelection(parts)).toEqual(['title', 'username', 'password', 'url']);
    });

    it('puts in the file exactly what was ticked', async () => {
        const rich = entry({
            customFields: [{ key: 'API key', value: kdbxweb.ProtectedValue.fromString('sk-live-1'), protected: true }],
            attachments: [{ name: 'key.pem', data: new TextEncoder().encode('PRIVATE KEY').buffer }],
        });
        const { html: page, share } = await SecretShareService.create(rich, options({
            include: ['username', 'field:API key', 'file:key.pem'],
        }));
        const blob = blobOf(html(page));
        const opened = await openWithCode(blob, '', (await SecretShareService.currentCode(share))!.code);

        expect(opened.items.map((item: any) => item.label)).toEqual(['Username', 'API key', 'key.pem']);
        expect(valueOf(opened, 'API key')).toBe('sk-live-1');
        expect(itemOf(opened, 'API key').kind).toBe('secret');
        // The password was never ticked, so it is in no part of the file
        expect(html(page)).not.toContain('sixteen bananas');
        expect(opened.items.some((item: any) => item.value === 'sixteen bananas')).toBe(false);

        const file = itemOf(opened, 'key.pem');
        expect(file.kind).toBe('file');
        expect(file.size).toBe('11 B');
        expect(new TextDecoder().decode(bytes(file.data))).toBe('PRIVATE KEY');
    });

    it('carries a one-time code as its settings, so the page makes live codes', async () => {
        const withOtp = entry({
            customFields: [{ key: 'otp', value: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=30&digits=6', protected: false }],
        });
        const { html: page, share } = await SecretShareService.create(withOtp, options({ include: ['otp'] }));
        const blob = blobOf(html(page));
        const opened = await openWithCode(blob, '', (await SecretShareService.currentCode(share))!.code);

        const otp = itemOf(opened, 'One-time code');
        expect(otp.kind).toBe('otp');
        expect(otp.type).toBe('totp');
        expect(otp.secret).toBe('JBSWY3DPEHPK3PXP');
        expect(otp.period).toBe(30);
        expect(otp.digits).toBe(6);
        expect(otp.algorithm).toBe('SHA-1');
    });

    it('carries a counter-based code at the counter the vault is on', async () => {
        const withHotp = entry({
            customFields: [{ key: 'otp', value: 'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=41&digits=6', protected: false }],
        });
        const parts = SecretShareService.partsOf(withHotp);
        expect(parts.find(p => p.id === 'otp')?.detail).toBe('counter-based, one code at a time');

        const { html: page, share } = await SecretShareService.create(withHotp, options({ include: ['otp'] }));
        const blob = blobOf(html(page));
        const opened = await openWithCode(blob, '', (await SecretShareService.currentCode(share))!.code);

        const otp = itemOf(opened, 'One-time code');
        expect(otp.type).toBe('hotp');
        expect(otp.counter).toBe(41);
        expect(otp.period).toBeUndefined();
        expect(otp.secret).toBe('JBSWY3DPEHPK3PXP');
    });

    it('builds the file and the hosted page from one source, differing only in where the blob comes from', async () => {
        const digest = async (value: string) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(
            await crypto.subtle.digest('SHA-256', utf8(value)))))}`;
        const file = await buildPage(INLINE_BLOB('{"mode":"approved"}'), digest);
        const hosted = await buildPage(FRAGMENT_BLOB, digest);

        // Strip the one line that differs, and the hash of the script that
        // line sits in, and nothing else may be left over
        const strip = (page: string) => page
            .replace(/var BLOB = [\s\S]*?;\nvar ALPHABET/, 'var BLOB = <blob>;\nvar ALPHABET')
            .replace(/script-src 'sha256-[^']+'/, "script-src '<hash>'");
        expect(strip(file)).toBe(strip(hosted));

        // And the difference is the one intended: inline bytes against a read
        // of the fragment
        expect(file).toContain('var BLOB = {"mode":"approved"};');
        expect(hosted).toContain('location.hash.slice(1)');
        expect(hosted).not.toContain('"mode":"approved"');
    });

    it('puts the share in the fragment, which never reaches the page\'s host', async () => {
        const { link, share } = await SecretShareService.create(entry(), options());
        expect(link.startsWith(`${SecretShareService.SHARE_PAGE_URL}#`)).toBe(true);
        expect(link).not.toContain('?');

        // What the page reads back is what was put in
        const fragment = link.slice(link.indexOf('#') + 1);
        const blob = JSON.parse(new TextDecoder().decode(
            bytes(fragment.replace(/-/g, '+').replace(/_/g, '/'))));
        expect(blob.wraps).toHaveLength(share.schedule!.count);
        expect(blob.sender).toBe('Ryan');
        expect(blob.codeLength).toBe(SecretShareService.CODE_LENGTH);
        // base64url: nothing that needs escaping in a URL
        expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('gives a link that fits a message for a day of codes, and one that does not for a file', async () => {
        const login = ['title', 'username', 'password'];
        const short = await SecretShareService.create(entry(), options({ include: login }));
        expect(short.link.length).toBeLessThan(SecretShareService.LINK_BUDGET);

        // A key small enough to carry rides in the link too
        const withKey = entry({ attachments: [{ name: 'id_ed25519', data: new ArrayBuffer(411) }] });
        const keyed = await SecretShareService.create(withKey, options({ include: [...login, 'file:id_ed25519'] }));
        expect(keyed.link.length).toBeLessThan(SecretShareService.LINK_BUDGET);

        // A real file is past what a link can carry, and the caller sees that
        // from the link itself
        const withFile = entry({ attachments: [{ name: 'key.pem', data: new ArrayBuffer(64 * 1024) }] });
        const heavy = await SecretShareService.create(withFile, options({
            include: [...login, 'file:key.pem'],
        }));
        expect(heavy.link.length).toBeGreaterThan(SecretShareService.LINK_BUDGET);

        // The file is made either way, so falling back to it costs no work
        expect(heavy.html.length).toBeGreaterThan(0);
    });

    it('pins the script and the style it ships, and reaches nothing', async () => {
        const { html: page } = await SecretShareService.create(entry(), options());
        const text = html(page);
        const csp = text.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';

        expect(csp).toContain("default-src 'none'");
        expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
        expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);

        const script = text.match(/<script>(.*?)<\/script>/s)?.[1] ?? '';
        const digest = await crypto.subtle.digest('SHA-256', utf8(script));
        const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
        expect(csp).toContain(`script-src 'sha256-${hash}'`);

        // A module never runs from file://, and nothing may be fetched
        expect(script).not.toContain('import ');
        expect(text).not.toMatch(/<script[^>]+src=/);
    });

    it('writes the payload through textContent, never as markup', async () => {
        const { html: page, share } = await SecretShareService.create(
            entry({ title: '<img src=x onerror=alert(1)>' }), options());
        const blob = blobOf(html(page));
        const current = await SecretShareService.currentCode(share);

        const secret = await openWithCode(blob, '', current!.code);
        expect(valueOf(secret, 'Site')).toBe('<img src=x onerror=alert(1)>');
        // It survives the round trip as text and never reaches the document as
        // markup: the page has no innerHTML at all
        expect(html(page)).not.toContain('innerHTML');
    });
});

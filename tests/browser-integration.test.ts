import { describe, it, expect, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

installMockWindow();
const { BrowserIntegrationService: Svc } = await import('../src/services/BrowserIntegrationService');
const { userSettingsService } = await import('../src/services/UserSettingsService');

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const root = db0.getDefaultGroup();

    const gh = db0.createEntry(root);
    gh.fields.set('Title', 'GitHub');
    gh.fields.set('UserName', 'octo');
    gh.fields.set('Password', kdbxweb.ProtectedValue.fromString('hub-pass'));
    gh.fields.set('URL', 'https://github.com/login');
    gh.fields.set('otp', kdbxweb.ProtectedValue.fromString(
        'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    ));

    const other = db0.createEntry(root);
    other.fields.set('Title', 'Example');
    other.fields.set('UserName', 'user');
    other.fields.set('Password', kdbxweb.ProtectedValue.fromString('ex-pass'));
    other.fields.set('URL', 'https://app.example.com');

    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

const ctxFor = (kdbxDb: kdbxweb.Kdbx, pairingName: string | null = null) => ({
    database: {} as any,
    kdbxDb,
    saveDatabase: vi.fn(async () => {}),
    requestPairing: vi.fn(async (_fingerprint: string, _existingNames: string[]) => pairingName),
    requestSetLoginConsent: vi.fn(async () => true),
    requestAccessConsent: vi.fn(async ({ entries }: { entries: Array<{ id: string }> }) =>
        ({ allowedIds: entries.map(e => e.id), remember: false })),
});

// Follows KeePassXC's BrowserService::handleURL, so a database moved between
// the two applications gets the same credentials offered on the same pages
describe('url matching', () => {
    it('matches the same host, ignoring path and www', () => {
        expect(Svc.urlMatches('https://github.com/login', 'https://github.com')).toBe(true);
        expect(Svc.urlMatches('https://www.github.com', 'https://github.com')).toBe(true);
        expect(Svc.urlMatches('https://github.com', 'https://www.github.com')).toBe(true);
        expect(Svc.urlMatches(undefined, 'https://github.com')).toBe(false);
    });

    it('offers an entry on subdomains of its host but not the other way round', () => {
        expect(Svc.urlMatches('https://example.com', 'https://app.example.com')).toBe(true);
        expect(Svc.urlMatches('https://example.com', 'https://deep.app.example.com')).toBe(true);
        // KeePassXC tests siteHost.endsWith(entryHost), so an entry saved for a
        // subdomain is not handed out on the parent
        expect(Svc.urlMatches('https://app.example.com', 'https://example.com')).toBe(false);
    });

    it('does not fall for a host that merely ends with the entry host', () => {
        expect(Svc.urlMatches('https://github.com', 'https://gitlab.com')).toBe(false);
        expect(Svc.urlMatches('https://github.com', 'https://notgithub.com')).toBe(false);
        expect(Svc.urlMatches('https://notgithub.com', 'https://github.com')).toBe(false);
        expect(Svc.urlMatches('https://example.com', 'https://evilexample.com')).toBe(false);
    });

    it('does not hand an https entry to an http page', () => {
        expect(Svc.urlMatches('https://example.com', 'http://example.com')).toBe(false);
        expect(Svc.urlMatches('http://example.com', 'https://example.com')).toBe(false);
        expect(Svc.urlMatches('https://example.com', 'https://example.com')).toBe(true);
    });

    it('reads an entry with no scheme as https', () => {
        // A bare host is the common way to fill the URL field in by hand
        expect(Svc.urlMatches('example.com', 'https://example.com')).toBe(true);
        expect(Svc.urlMatches('example.com', 'http://example.com')).toBe(false);
        // Writing the scheme is how an intranet or local site opts back in
        expect(Svc.urlMatches('http://intranet.local', 'http://intranet.local')).toBe(true);
    });

    it('matches a port only when the entry names one', () => {
        expect(Svc.urlMatches('https://example.com:8443', 'https://example.com:8443')).toBe(true);
        expect(Svc.urlMatches('https://example.com:8443', 'https://example.com')).toBe(false);
        expect(Svc.urlMatches('https://example.com:8443', 'https://example.com:9000')).toBe(false);
        // No port on the entry means any port on the site
        expect(Svc.urlMatches('https://example.com', 'https://example.com:8443')).toBe(true);
    });

    it('rejects an entry url carrying characters a url cannot hold', () => {
        for (const bad of ['https://exa<mple.com', 'https://example.com/{a}', 'https://exa|mple.com']) {
            expect(Svc.urlMatches(bad, 'https://example.com')).toBe(false);
        }
    });
});

describe('association', () => {
    it('associate stores the key under the chosen name and saves', async () => {
        const db = await makeDb();
        const ctx = ctxFor(db, 'Firefox');
        const result = await Svc.handleRequest('associate', { key: 'sess', idKey: 'id-key-b64' }, ctx);

        expect(result.id).toBe('Firefox');
        expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(db.meta.customData.get('KPXC_BROWSER_Firefox')?.value).toBe('id-key-b64');
        expect(ctx.saveDatabase).toHaveBeenCalled();
        expect(Svc.listAssociations(db)).toEqual([{ name: 'Firefox', key: 'id-key-b64' }]);
    });

    // Reusing a name replaces that pairing's key and leaves the browser
    // holding the old one silently de-authorized, so the dialog is handed the
    // names already in the database and warns first. KeePassXC's storeKey
    // asks the same question ("Overwrite existing key?") before replacing
    it('hands the pairing dialog the names already in the database', async () => {
        const db = await makeDb();
        db.meta.customData.set('KPXC_BROWSER_Firefox', { value: 'old-key' });
        db.meta.customData.set('KPXC_BROWSER_Chrome', { value: 'other-key' });

        const ctx = ctxFor(db, 'Edge');
        await Svc.handleRequest('associate', { key: 'sess', idKey: 'new-key' }, ctx);

        expect(ctx.requestPairing).toHaveBeenCalledWith('new-key', ['Firefox', 'Chrome']);
    });

    it('passes an empty list when nothing is paired yet', async () => {
        const db = await makeDb();
        const ctx = ctxFor(db, 'Firefox');
        await Svc.handleRequest('associate', { key: 'sess', idKey: 'k' }, ctx);
        expect(ctx.requestPairing).toHaveBeenCalledWith('k', []);
    });

    it('flags a reused name as a collision, exactly and after trimming', () => {
        const existing = ['Firefox', 'Chrome'];
        expect(Svc.pairingNameCollides('Firefox', existing)).toBe(true);
        expect(Svc.pairingNameCollides('  Firefox  ', existing)).toBe(true);
        expect(Svc.pairingNameCollides('Edge', existing)).toBe(false);
        expect(Svc.pairingNameCollides('Firefox 2', existing)).toBe(false);
        expect(Svc.pairingNameCollides('Firefox', [])).toBe(false);
    });

    // Custom data keys are case sensitive, so these two coexist rather than
    // one replacing the other; warning about it would be a false alarm
    it('does not flag a name differing only in case', () => {
        expect(Svc.pairingNameCollides('firefox', ['Firefox'])).toBe(false);
    });

    it('denied pairing returns an error and stores nothing', async () => {
        const db = await makeDb();
        const result = await Svc.handleRequest('associate', { key: 's', idKey: 'k' }, ctxFor(db, null));
        expect(result.errorCode).toBe(17);
        expect(Svc.listAssociations(db)).toEqual([]);
    });

    it('rolls the pairing back and reports failure when the save fails', async () => {
        const db = await makeDb();
        const ctx = { ...ctxFor(db, 'Firefox'), saveDatabase: vi.fn(async () => { throw new Error('disk full'); }) };
        const result = await Svc.handleRequest('associate', { key: 'sess', idKey: 'id-key-b64' }, ctx);

        expect(result.errorCode).toBe(8); // ERROR_ASSOCIATION_FAILED
        expect(Svc.listAssociations(db)).toEqual([]);
    });

    it('test-associate validates name and key', async () => {
        const db = await makeDb();
        db.meta.customData.set('KPXC_BROWSER_Firefox', { value: 'the-key' });

        const ok = await Svc.handleRequest('test-associate', { id: 'Firefox', key: 'the-key' }, ctxFor(db));
        expect(ok.id).toBe('Firefox');

        const bad = await Svc.handleRequest('test-associate', { id: 'Firefox', key: 'wrong' }, ctxFor(db));
        expect(bad.errorCode).toBe(8);
    });
});

describe('get-logins', () => {
    it('requires a matching association key', async () => {
        const db = await makeDb();
        db.meta.customData.set('KPXC_BROWSER_FF', { value: 'good' });
        const denied = await Svc.handleRequest('get-logins', {
            url: 'https://github.com', keys: [{ id: 'FF', key: 'bad' }],
        }, ctxFor(db));
        expect(denied.errorCode).toBe(8);
    });

    it('returns matching entries with credentials and a TOTP code', async () => {
        const db = await makeDb();
        db.meta.customData.set('KPXC_BROWSER_FF', { value: 'good' });
        const result = await Svc.handleRequest('get-logins', {
            url: 'https://github.com', keys: [{ id: 'FF', key: 'good' }],
        }, ctxFor(db));

        expect(result.entries).toHaveLength(1);
        const login = result.entries[0];
        expect(login.login).toBe('octo');
        expect(login.password).toBe('hub-pass');
        expect(login.name).toBe('GitHub');
        expect(login.uuid).toMatch(/^[0-9a-f]{32}$/);
        expect(login.totp).toMatch(/^\d{6}$/);
    });

    it('reports no logins for an unknown site', async () => {
        const db = await makeDb();
        db.meta.customData.set('KPXC_BROWSER_FF', { value: 'good' });
        const result = await Svc.handleRequest('get-logins', {
            url: 'https://nowhere.net', keys: [{ id: 'FF', key: 'good' }],
        }, ctxFor(db));
        expect(result.errorCode).toBe(15);
    });
});

// Association authenticates the channel; each entry still needs the user's
// permission before its password leaves the vault. Decisions are stored the
// way KeePassXC's BrowserEntryConfig stores them, so they carry across
describe('get-logins access control', () => {
    const paired = async () => {
        const db = await makeDb();
        db.meta.customData.set('KPXC_BROWSER_FF', { value: 'good' });
        return db;
    };
    const request = { url: 'https://github.com', keys: [{ id: 'FF', key: 'good' }] };

    it('asks before handing out an entry with no stored decision', async () => {
        const db = await paired();
        const ctx = ctxFor(db);
        const result = await Svc.handleRequest('get-logins', request, ctx);

        expect(ctx.requestAccessConsent).toHaveBeenCalledTimes(1);
        const asked = ctx.requestAccessConsent.mock.calls[0][0];
        expect(asked.host).toBe('github.com');
        expect(asked.entries).toEqual([expect.objectContaining({ title: 'GitHub', username: 'octo' })]);
        expect(result.entries).toHaveLength(1);
    });

    it('withholds every entry when the user denies', async () => {
        const db = await paired();
        const ctx = { ...ctxFor(db), requestAccessConsent: vi.fn(async () => null) };
        const result = await Svc.handleRequest('get-logins', request, ctx);
        expect(result.errorCode).toBe(15);
    });

    it('fails closed when the host provides no consent callback', async () => {
        const db = await paired();
        const ctx = { ...ctxFor(db), requestAccessConsent: undefined };
        const result = await Svc.handleRequest('get-logins', request, ctx);
        expect(result.errorCode).toBe(15);
    });

    it('remembers an allow: writes KeePassXC browser settings and stops asking', async () => {
        const db = await paired();
        const ctx = {
            ...ctxFor(db),
            requestAccessConsent: vi.fn(async ({ entries }: { entries: Array<{ id: string }> }) =>
                ({ allowedIds: entries.map(e => e.id), remember: true })),
        };
        await Svc.handleRequest('get-logins', request, ctx);

        const entry = db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'GitHub')!;
        const stored = JSON.parse(entry.customData!.get('KeePassXC-Browser Settings')!.value!);
        expect(stored.Allow).toEqual(['github.com']);
        expect(ctx.saveDatabase).toHaveBeenCalled();

        const again = await Svc.handleRequest('get-logins', request, ctx);
        expect(ctx.requestAccessConsent).toHaveBeenCalledTimes(1);
        expect(again.entries).toHaveLength(1);
    });

    it('remembers a deny: the entry stays withheld without asking again', async () => {
        const db = await paired();
        const ctx = {
            ...ctxFor(db),
            requestAccessConsent: vi.fn(async () => ({ allowedIds: [], remember: true })),
        };
        const first = await Svc.handleRequest('get-logins', request, ctx);
        expect(first.errorCode).toBe(15);

        const entry = db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'GitHub')!;
        const stored = JSON.parse(entry.customData!.get('KeePassXC-Browser Settings')!.value!);
        expect(stored.Deny).toEqual(['github.com']);

        const again = await Svc.handleRequest('get-logins', request, ctx);
        expect(again.errorCode).toBe(15);
        expect(ctx.requestAccessConsent).toHaveBeenCalledTimes(1);
    });

    it('honors a decision KeePassXC wrote, deny outranking allow', async () => {
        const db = await paired();
        const entry = db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'GitHub')!;
        entry.customData = new Map([[
            'KeePassXC-Browser Settings',
            { value: '{"Allow":["github.com"],"Deny":[],"Realm":""}' },
        ]]);
        const ctx = ctxFor(db);
        const result = await Svc.handleRequest('get-logins', request, ctx);
        expect(ctx.requestAccessConsent).not.toHaveBeenCalled();
        expect(result.entries).toHaveLength(1);

        entry.customData.set('KeePassXC-Browser Settings',
            { value: '{"Allow":["github.com"],"Deny":["github.com"]}' });
        const denied = await Svc.handleRequest('get-logins', request, ctx);
        expect(denied.errorCode).toBe(15);
    });

    it('skips the confirmation when always-allow is on, but a remembered deny still holds', async () => {
        const db = await paired();
        const entry = db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'GitHub')!;
        const ctx = ctxFor(db);

        userSettingsService.setAlwaysAllowBrowserAccess(true);
        try {
            const result = await Svc.handleRequest('get-logins', request, ctx);
            expect(ctx.requestAccessConsent).not.toHaveBeenCalled();
            expect(result.entries).toHaveLength(1);

            entry.customData = new Map([[
                'KeePassXC-Browser Settings',
                { value: '{"Allow":[],"Deny":["github.com"]}' },
            ]]);
            const denied = await Svc.handleRequest('get-logins', request, ctx);
            expect(denied.errorCode).toBe(15);
        } finally {
            userSettingsService.setAlwaysAllowBrowserAccess(false);
        }
    });

    it('still answers when remembering cannot be saved', async () => {
        const db = await paired();
        const ctx = {
            ...ctxFor(db),
            saveDatabase: vi.fn(async () => { throw new Error('disk full'); }),
            requestAccessConsent: vi.fn(async ({ entries }: { entries: Array<{ id: string }> }) =>
                ({ allowedIds: entries.map(e => e.id), remember: true })),
        };
        const result = await Svc.handleRequest('get-logins', request, ctx);
        expect(result.entries).toHaveLength(1);
    });
});

describe('set-login', () => {
    it('creates a new entry in the Browser Passwords group', async () => {
        const db = await makeDb();
        const ctx = ctxFor(db);
        await Svc.handleRequest('set-login', {
            url: 'https://new.example.org/login', login: 'newuser', password: 'newpass',
        }, ctx);

        const group = db.getDefaultGroup().groups.find(g => g.name === 'Browser Passwords')!;
        expect(group).toBeDefined();
        const entry = group.entries[0];
        expect(entry.fields.get('Title')).toBe('new.example.org');
        expect(entry.fields.get('UserName')).toBe('newuser');
        expect((entry.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('newpass');
        expect(ctx.saveDatabase).toHaveBeenCalled();
    });

    it('is denied when the user declines the confirmation, and writes nothing', async () => {
        const db = await makeDb();
        const ctx = { ...ctxFor(db), requestSetLoginConsent: vi.fn(async () => false) };
        const before = db.getDefaultGroup().groups.find(g => g.name === 'Browser Passwords');
        const result = await Svc.handleRequest('set-login', {
            url: 'https://new.example.org/login', login: 'newuser', password: 'newpass',
        }, ctx);

        expect(result.errorCode).toBe(17); // ERROR_DENIED
        expect(ctx.requestSetLoginConsent).toHaveBeenCalled();
        expect(ctx.saveDatabase).not.toHaveBeenCalled();
        // no Browser Passwords group materialised from a denied write
        expect(db.getDefaultGroup().groups.find(g => g.name === 'Browser Passwords')).toBe(before);
    });

    it('fails closed when the host provides no confirmation callback', async () => {
        const db = await makeDb();
        const ctx = { database: {} as any, kdbxDb: db, saveDatabase: vi.fn(async () => {}), requestPairing: vi.fn(async () => null) };
        const result = await Svc.handleRequest('set-login', {
            url: 'https://new.example.org/login', login: 'x', password: 'y',
        }, ctx);
        expect(result.errorCode).toBe(17);
        expect(ctx.saveDatabase).not.toHaveBeenCalled();
    });

    it('reports failure to the extension when the save fails', async () => {
        const db = await makeDb();
        const ctx = { ...ctxFor(db), saveDatabase: vi.fn(async () => { throw new Error('disk full'); }) };
        const result = await Svc.handleRequest('set-login', {
            url: 'https://new.example.org/login', login: 'newuser', password: 'newpass',
        }, ctx);

        expect(result.errorCode).toBe(17);
        expect(result.hash).toBeUndefined();
    });

    it('updates an existing entry by uuid and keeps history', async () => {
        const db = await makeDb();
        const ctx = ctxFor(db);
        db.meta.customData.set('KPXC_BROWSER_FF', { value: 'good' });
        const { entries } = await Svc.handleRequest('get-logins', {
            url: 'https://github.com', keys: [{ id: 'FF', key: 'good' }],
        }, ctx);

        await Svc.handleRequest('set-login', {
            url: 'https://github.com', login: 'octo', password: 'rotated', uuid: entries[0].uuid,
        }, ctx);

        const entry = db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'GitHub')!;
        expect((entry.fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('rotated');
        expect(entry.history.length).toBe(1);
    });
});

describe('get-totp', () => {
    it('refuses a code from an entry in the recycle bin', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        db.setVersion(3);
        const bin = db.createGroup(db.getDefaultGroup(), 'Recycle Bin');
        db.meta.recycleBinUuid = bin.uuid;
        db.meta.recycleBinEnabled = true;

        const entry = db.createEntry(bin);
        entry.fields.set('Title', 'Deleted');
        entry.fields.set('otp', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP');
        const uuid = [...kdbxweb.ByteUtils.base64ToBytes(entry.uuid.id)]
            .map(b => b.toString(16).padStart(2, '0')).join('');

        const ctx: any = { database: {}, kdbxDb: db, saveDatabase: async () => {}, requestPairing: async () => null };
        expect(await Svc.handleRequest('get-totp', { uuid }, ctx)).toEqual({ errorCode: 15 });
    });

    it('still serves one from a live entry', async () => {
        const db = kdbxweb.Kdbx.create(cred(), 'Vault');
        db.setVersion(3);
        const entry = db.createEntry(db.getDefaultGroup());
        entry.fields.set('Title', 'Live');
        entry.fields.set('otp', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP');
        const uuid = [...kdbxweb.ByteUtils.base64ToBytes(entry.uuid.id)]
            .map(b => b.toString(16).padStart(2, '0')).join('');

        const ctx: any = { database: {}, kdbxDb: db, saveDatabase: async () => {}, requestPairing: async () => null };
        const result = await Svc.handleRequest('get-totp', { uuid }, ctx);
        expect(result.totp).toMatch(/^\d{6}$/);
    });
});

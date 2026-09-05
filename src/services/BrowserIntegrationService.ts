import * as kdbxweb from 'kdbxweb';
import { CustomField, Database } from '../types/database';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { PlaceholderService, uuidBase64ToHex } from './PlaceholderService';
import { TotpService } from './TotpService';
import { PasswordGeneratorService } from './PasswordGeneratorService';
import { PassphraseService } from './PassphraseService';
import { PasskeyService, PasskeyEntryInfo, PASSKEY_ERRORS } from './PasskeyService';
import { userSettingsService } from './UserSettingsService';

// Renderer side of the KeePassXC-Browser protocol: answers the requests the
// main-process socket server forwards. Association keys are stored the way
// KeePassXC stores them (meta custom data, KPXC_BROWSER_<name> = base64 key),
// so a database keeps its browser pairings when moved between the two apps.

const ASSOCIATION_PREFIX = 'KPXC_BROWSER_';
const BROWSER_GROUP_NAME = 'Browser Passwords';

// Per-entry site permissions, stored the way KeePassXC's BrowserEntryConfig
// stores them (entry custom data, JSON {"Allow": [hosts], "Deny": [hosts]}),
// so decisions made in either app bind the other
const BROWSER_SETTINGS_KEY = 'KeePassXC-Browser Settings';

const ERROR_ASSOCIATION_FAILED = 8;
const ERROR_INCORRECT_ACTION = 12;
const ERROR_NO_URL_PROVIDED = 14;
const ERROR_NO_LOGINS_FOUND = 15;
const ERROR_DENIED = 17;
const ERROR_NO_VALID_UUID = 18;

// KeePassXC's per-entry browser options, entry custom data holding "true"
const OPTION_HIDE_ENTRY = 'BrowserHideEntry';
const OPTION_ONLY_HTTP_AUTH = 'BrowserOnlyHttpAuth';
const OPTION_NOT_HTTP_AUTH = 'BrowserNotHttpAuth';
const OPTION_SKIP_AUTO_SUBMIT = 'BrowserSkipAutoSubmit';

const UUID_HEX = /^[0-9a-f]{32}$/i;
// A code is asked for shortly after the login it belongs to was filled;
// page loads in between refresh the release
const RELEASE_TTL_MS = 10 * 60 * 1000;

export interface PasskeyConsentRequest {
    kind: 'register' | 'get';
    rpId: string;
    origin: string;
    username?: string;
    // get: matching credentials the user picks from
    entries?: Array<{ title: string; username: string; credentialId: string }>;
}

export interface AccessConsentRequest {
    url: string;
    host: string;
    entries: Array<{ id: string; title: string; username: string }>;
}

export interface AccessConsentResponse {
    // Entry ids the user granted; the rest are withheld
    allowedIds: string[];
    // Write the decisions (grant and refusal both) into the entries so this
    // site never asks again
    remember: boolean;
}

export interface SetLoginConsentRequest {
    url: string;
    login: string;
    // create: a new entry; update: overwriting an existing entry's password
    mode: 'create' | 'update';
    // set on update: the title of the entry that would be overwritten
    entryTitle?: string;
}

export interface BrowserRequestContext {
    database: Database;
    kdbxDb: kdbxweb.Kdbx;
    saveDatabase: () => Promise<void>;
    // Shows the pairing dialog; resolves with the connection name or null.
    // existingNames are the pairings the database already holds: a name that
    // repeats one of them replaces that pairing's key and silently
    // de-authorizes the browser holding it, so the dialog warns first
    requestPairing: (keyFingerprint: string, existingNames: string[]) => Promise<string | null>;
    // Shows the passkey consent dialog; resolves with the chosen credentialId
    // ('register' resolves with any non-null value on approval), null on deny
    requestPasskeyConsent?: (request: PasskeyConsentRequest) => Promise<string | null>;
    // Shows the save-login confirmation; resolves true to allow the write.
    // The browser extension does not send association keys with set-login, so
    // this user confirmation is the gate (same as KeePassXC). When absent, the
    // write fails closed
    requestSetLoginConsent?: (request: SetLoginConsentRequest) => Promise<boolean>;
    // Shows the credential access confirmation for get-logins: which of the
    // matching entries may be handed to this site. Resolves null to deny them
    // all without remembering. When absent, undecided entries are withheld:
    // association alone must never be enough to read passwords and TOTP codes
    requestAccessConsent?: (request: AccessConsentRequest) => Promise<AccessConsentResponse | null>;
}

export class BrowserIntegrationService {
    static listAssociations(kdbxDb: kdbxweb.Kdbx): Array<{ name: string; key: string }> {
        const result: Array<{ name: string; key: string }> = [];
        for (const [key, item] of kdbxDb.meta.customData) {
            if (key.startsWith(ASSOCIATION_PREFIX) && item?.value) {
                result.push({ name: key.slice(ASSOCIATION_PREFIX.length), key: item.value });
            }
        }
        return result;
    }

    static removeAssociation(kdbxDb: kdbxweb.Kdbx, name: string): void {
        kdbxDb.meta.customData.delete(ASSOCIATION_PREFIX + name);
    }

    // Whether pairing under this name would replace an existing pairing, and
    // so silently de-authorize the browser holding it. Exact matches only,
    // after the same trim the dialog applies before storing: custom data keys
    // are case sensitive, so "firefox" next to "Firefox" is a second pairing
    // rather than a replacement, and warning about it would be a false alarm
    static pairingNameCollides(name: string, existingNames: string[]): boolean {
        return existingNames.includes(name.trim());
    }

    static async databaseHash(kdbxDb: kdbxweb.Kdbx): Promise<string> {
        const uuidBytes = kdbxweb.ByteUtils.base64ToBytes(kdbxDb.getDefaultGroup().uuid.id);
        const digest = await crypto.subtle.digest('SHA-256', uuidBytes.slice().buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // KeePassXC rejects these outright in handleURL before any matching
    private static readonly ILLEGAL_URL_CHARS = /[<>^`{|}]/;

    // An entry URL with no scheme is read as https, the way KeePassXC does
    // when its match-scheme setting is on (the default). A site that genuinely
    // speaks http can still be matched by writing the scheme into the entry,
    // which is the escape hatch for intranet and local addresses
    private static parseUrl(url: string): URL | null {
        try {
            return new URL(url.includes('://') ? url : `https://${url}`);
        } catch {
            return null;
        }
    }

    private static readonly DEFAULT_PORTS: Record<string, string> = {
        'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21',
    };

    private static effectivePort(url: URL): string {
        return url.port || this.DEFAULT_PORTS[url.protocol] || '';
    }

    // Whether the text spells out a port: the authority, after any userinfo,
    // ends in ':digits'. A bracketed IPv6 host without a port ends in ']'
    private static namesPort(url: string): boolean {
        const authority = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
        const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
        return /:\d+$/.test(hostPort);
    }

    static hostOf(url: string): string {
        const parsed = this.parseUrl(url);
        return (parsed?.hostname ?? url).toLowerCase().replace(/^www\./, '');
    }

    // The host a stored access decision is keyed on: the full hostname, www
    // included, which is what KeePassXC writes (QUrl::host of the site URL)
    // and reads. Keying on the stripped form, as earlier versions did, made
    // every decision taken in one app get asked again in the other
    static decisionHost(url: string): string {
        const parsed = this.parseUrl(url);
        return (parsed?.hostname ?? url).toLowerCase();
    }

    // The spellings a decision for this host may have been recorded under:
    // the full host, and the www-less form earlier Vigil versions wrote
    private static decisionAliases(host: string): string[] {
        const stripped = host.replace(/^www\./, '');
        return stripped === host ? [host] : [host, stripped];
    }

    // Mirrors KeePassXC's BrowserService::handleURL, which is the reference
    // implementation for this protocol, in the same order: illegal characters,
    // then port, then scheme, then host.
    //
    // KeePassXC guards its host test with a public suffix lookup because its
    // test is a bare endsWith, which would otherwise let an entry for
    // example.com match evilexample.com. The comparison below requires a dot
    // before the entry host, so that confusion cannot arise and the suffix
    // list buys only one thing: refusing an entry stored against a bare public
    // suffix such as github.io. That is rare enough not to be worth carrying
    // ten thousand rules that go stale.
    static urlMatches(entryUrl: string | undefined, requestUrl: string): boolean {
        if (!entryUrl || this.ILLEGAL_URL_CHARS.test(entryUrl)) return false;

        const entry = this.parseUrl(entryUrl);
        const site = this.parseUrl(requestUrl);
        if (!entry || !site) return false;

        const entryHost = entry.hostname.toLowerCase().replace(/^www\./, '');
        const siteHost = site.hostname.toLowerCase().replace(/^www\./, '');
        if (!entryHost || !siteHost) return false;

        // Only when the entry names one. The parser drops a default port
        // (https://host:443 reads back with no port), so whether the entry
        // named one is read off its text, and the comparison is on the port
        // each side is actually on
        if (this.namesPort(entryUrl) && this.effectivePort(entry) !== this.effectivePort(site)) return false;

        // An entry saved for https is not handed to an http page
        if (entry.protocol !== site.protocol) return false;

        // The site may be a subdomain of the entry, not the reverse: an entry
        // for mail.example.com is not offered up on example.com
        return siteHost === entryHost || siteHost.endsWith('.' + entryHost);
    }

    private static uuidHex(uuid: kdbxweb.KdbxUuid): string {
        // Shared with {REF:...@I:...} matching; the two must agree byte for byte
        return uuidBase64ToHex(uuid.id);
    }

    private static fieldString(value: string | kdbxweb.ProtectedValue | undefined): string {
        if (value === undefined) return '';
        return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
    }

    // What the entry's stored browser settings say about handing it to this
    // host. Deny wins over allow, the way KeePassXC reads the same record
    static accessDecision(entry: kdbxweb.KdbxEntry, host: string): 'allow' | 'deny' | 'unknown' {
        const raw = entry.customData?.get(BROWSER_SETTINGS_KEY)?.value;
        if (!raw) return 'unknown';
        try {
            const config = JSON.parse(raw);
            const aliases = this.decisionAliases(host);
            const listed = (list: unknown) => Array.isArray(list) && aliases.some(alias => list.includes(alias));
            if (listed(config.Deny)) return 'deny';
            if (listed(config.Allow)) return 'allow';
        } catch { /* unreadable settings decide nothing */ }
        return 'unknown';
    }

    static recordAccessDecision(entry: kdbxweb.KdbxEntry, host: string, allowed: boolean): void {
        let config: any = {};
        const raw = entry.customData?.get(BROWSER_SETTINGS_KEY)?.value;
        if (raw) {
            try {
                config = JSON.parse(raw) ?? {};
            } catch { /* start over rather than carry unreadable settings */ }
        }
        const allow = new Set<string>(Array.isArray(config.Allow) ? config.Allow : []);
        const deny = new Set<string>(Array.isArray(config.Deny) ? config.Deny : []);
        // A fresh decision replaces every earlier spelling of it, so a
        // www-less refusal from an older version cannot outrank a grant
        // recorded now (deny wins on read)
        for (const alias of this.decisionAliases(host)) {
            allow.delete(alias);
            deny.delete(alias);
        }
        (allowed ? allow : deny).add(host);
        config.Allow = [...allow];
        config.Deny = [...deny];
        if (!entry.customData) entry.customData = new Map();
        entry.customData.set(BROWSER_SETTINGS_KEY, { value: JSON.stringify(config), lastModified: new Date() });
    }

    private static isAssociated(kdbxDb: kdbxweb.Kdbx, keys: unknown): boolean {
        if (!Array.isArray(keys)) return false;
        for (const item of keys) {
            if (!item || typeof item !== 'object') continue;
            const { id, key } = item as { id?: unknown; key?: unknown };
            if (typeof id !== 'string' || typeof key !== 'string') continue;
            const stored = kdbxDb.meta.customData.get(ASSOCIATION_PREFIX + id);
            if (stored?.value && stored.value === key) return true;
        }
        return false;
    }

    private static browserOption(entry: kdbxweb.KdbxEntry, name: string): boolean {
        return entry.customData?.get(name)?.value === 'true';
    }

    // Entries handed to the browser by get-logins, by uuid, with the time.
    // get-totp names only a uuid, so this is what ties a code request to a
    // credential the user (or a stored decision) released to the site; the
    // session-level association check in the main process says nothing
    // about entries
    private static released = new Map<string, number>();

    private static release(entries: kdbxweb.KdbxEntry[]): void {
        const now = Date.now();
        for (const entry of entries) this.released.set(this.uuidHex(entry.uuid), now);
    }

    private static isReleased(uuidHex: string): boolean {
        const at = this.released.get(uuidHex);
        return at !== undefined && Date.now() - at <= RELEASE_TTL_MS;
    }

    static resetReleasesForTests(): void {
        this.released.clear();
    }

    // Payloads come off the socket from whatever holds the extension's
    // storage. A field of the wrong shape fails here, before anything is
    // looked up or created
    private static invalidPayload(action: string, payload: any): number | null {
        const optionalString = (value: unknown) => value === undefined || value === null || typeof value === 'string';
        const url = () => typeof payload.url === 'string' && payload.url.length > 0 ? null : ERROR_NO_URL_PROVIDED;
        switch (action) {
            case 'associate':
                return typeof payload.idKey === 'string' && payload.idKey.length > 0 && payload.idKey.length <= 128
                    ? null : ERROR_ASSOCIATION_FAILED;
            case 'test-associate':
                return typeof payload.id === 'string' && typeof payload.key === 'string' ? null : ERROR_ASSOCIATION_FAILED;
            case 'get-logins':
                return url() ?? (optionalString(payload.submitUrl) ? null : ERROR_INCORRECT_ACTION);
            case 'set-login':
                if (url()) return url();
                if (payload.uuid !== undefined && payload.uuid !== null && !(typeof payload.uuid === 'string' && UUID_HEX.test(payload.uuid))) return ERROR_NO_VALID_UUID;
                // The extension always sends both, empty or not
                if (typeof payload.login !== 'string' || typeof payload.password !== 'string') return ERROR_INCORRECT_ACTION;
                return [payload.submitUrl, payload.group, payload.groupUuid].every(optionalString) ? null : ERROR_INCORRECT_ACTION;
            case 'get-totp':
                return typeof payload.uuid === 'string' && UUID_HEX.test(payload.uuid) ? null : ERROR_NO_VALID_UUID;
            default:
                return null;
        }
    }

    private static *allEntries(group: kdbxweb.KdbxGroup, recycleBinUuid?: string): Generator<kdbxweb.KdbxEntry> {
        if (recycleBinUuid && group.uuid.id === recycleBinUuid) return;
        for (const entry of group.entries) yield entry;
        for (const child of group.groups) yield* this.allEntries(child, recycleBinUuid);
    }

    private static async entryToLogin(entry: kdbxweb.KdbxEntry, kdbxDb: kdbxweb.Kdbx): Promise<any> {
        // Resolved the way KeePassXC hands logins out: an entry whose
        // username is {REF:U@I:...} must fill the referenced value, not the
        // reference text. The recycle bin is out of scope, as it is for the
        // UI's resolver: a deleted credential must not be autofillable
        const root = kdbxDb.getDefaultGroup();
        const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
        const resolve = (value: string | kdbxweb.ProtectedValue | undefined) =>
            PlaceholderService.resolveKdbx(this.fieldString(value), entry, root, recycleBinUuid);
        const login: any = {
            login: resolve(entry.fields.get('UserName')),
            name: resolve(entry.fields.get('Title')),
            password: resolve(entry.fields.get('Password')),
            uuid: this.uuidHex(entry.uuid),
            group: entry.parentGroup?.name ?? '',
        };
        if (this.browserOption(entry, OPTION_SKIP_AUTO_SUBMIT)) login.skipAutoSubmit = 'true';
        const otpConfig = TotpService.getConfig(this.customFieldsOf(entry));
        // Time-based only: get-logins runs on every page load, and a HOTP
        // code handed out here would burn a counter each time. HOTP is
        // served by get-totp, which the user triggers
        if (otpConfig?.type === 'totp') {
            try {
                login.totp = await TotpService.generateCode(otpConfig);
            } catch {
                // unusable TOTP config; leave the field out
            }
        }
        return login;
    }

    private static customFieldsOf(entry: kdbxweb.KdbxEntry): CustomField[] {
        return [...entry.fields]
            .filter(([key]) => !['Title', 'UserName', 'Password', 'URL', 'Notes'].includes(key))
            .map(([key, value]) => ({ key, value, protected: value instanceof kdbxweb.ProtectedValue }));
    }

    static async handleRequest(action: string, rawPayload: unknown, ctx: BrowserRequestContext): Promise<any> {
        const { kdbxDb } = ctx;
        const payload: any = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
        const invalid = this.invalidPayload(action, payload);
        if (invalid !== null) return { errorCode: invalid };
        switch (action) {
            case 'get-databasehash':
                return { hash: await this.databaseHash(kdbxDb) };

            case 'associate': {
                const fingerprint = payload.idKey.slice(0, 12);
                const existingNames = this.listAssociations(kdbxDb).map(a => a.name);
                const name = await ctx.requestPairing(fingerprint, existingNames);
                if (!name) return { errorCode: ERROR_DENIED };
                kdbxDb.meta.customData.set(ASSOCIATION_PREFIX + name, { value: payload.idKey });
                try {
                    await ctx.saveDatabase();
                } catch {
                    // The pairing never reached the file, so the browser must
                    // not believe it holds one; take it back out of memory too
                    kdbxDb.meta.customData.delete(ASSOCIATION_PREFIX + name);
                    return { errorCode: ERROR_ASSOCIATION_FAILED };
                }
                return { hash: await this.databaseHash(kdbxDb), id: name };
            }

            case 'test-associate': {
                const stored = kdbxDb.meta.customData.get(ASSOCIATION_PREFIX + payload.id);
                if (!stored?.value || stored.value !== payload.key) {
                    return { errorCode: ERROR_ASSOCIATION_FAILED };
                }
                return { hash: await this.databaseHash(kdbxDb), id: payload.id };
            }

            case 'get-logins': {
                if (!this.isAssociated(kdbxDb, payload.keys)) {
                    return { errorCode: ERROR_ASSOCIATION_FAILED };
                }
                const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
                // KeePassXC's entry options: hidden entries are never
                // offered, and the HTTP auth ones only to the kind of
                // prompt they were marked for
                const httpAuth = payload.httpAuth === true || payload.httpAuth === 'true';
                const matching: kdbxweb.KdbxEntry[] = [];
                for (const entry of this.allEntries(kdbxDb.getDefaultGroup(), recycleBinUuid)) {
                    if (this.browserOption(entry, OPTION_HIDE_ENTRY)) continue;
                    if (this.browserOption(entry, httpAuth ? OPTION_NOT_HTTP_AUTH : OPTION_ONLY_HTTP_AUTH)) continue;
                    const url = this.fieldString(entry.fields.get('URL'));
                    if (this.urlMatches(url, payload.url)) {
                        matching.push(entry);
                    }
                }

                // The association key authenticates the channel, not the read:
                // anything holding the extension's storage holds that key. Each
                // entry needs the user's standing permission for this site, or
                // a fresh confirmation (same second gate as KeePassXC)
                const siteHost = this.decisionHost(payload.url);
                const granted: kdbxweb.KdbxEntry[] = [];
                const undecided: kdbxweb.KdbxEntry[] = [];
                for (const entry of matching) {
                    const decision = this.accessDecision(entry, siteHost);
                    if (decision === 'allow') granted.push(entry);
                    else if (decision === 'unknown') undecided.push(entry);
                }

                // The user can opt out of per-entry confirmations, the way
                // KeePassXC's "always allow access" does. A remembered refusal
                // still holds: the setting only answers the undecided
                if (userSettingsService.getAlwaysAllowBrowserAccess()) {
                    granted.push(...undecided);
                    undecided.length = 0;
                }

                if (undecided.length > 0 && ctx.requestAccessConsent) {
                    // Resolved for the dialog: the user is deciding about the
                    // credential a reference points at, not the token text
                    const shown = (entry: kdbxweb.KdbxEntry, name: string) =>
                        PlaceholderService.resolveKdbx(this.fieldString(entry.fields.get(name)), entry, kdbxDb.getDefaultGroup(), recycleBinUuid);
                    const consent = await ctx.requestAccessConsent({
                        url: payload.url,
                        host: siteHost,
                        entries: undecided.map(entry => ({
                            id: this.uuidHex(entry.uuid),
                            title: shown(entry, 'Title'),
                            username: shown(entry, 'UserName'),
                        })),
                    });
                    if (consent) {
                        for (const entry of undecided) {
                            const allowed = consent.allowedIds.includes(this.uuidHex(entry.uuid));
                            if (consent.remember) this.recordAccessDecision(entry, siteHost, allowed);
                            if (allowed) granted.push(entry);
                        }
                        if (consent.remember) {
                            try {
                                await ctx.saveDatabase();
                            } catch { /* the decisions hold in memory and ride the next save */ }
                        }
                    }
                }

                if (granted.length === 0) return { errorCode: ERROR_NO_LOGINS_FOUND };
                this.release(granted);
                const entries: any[] = [];
                for (const entry of granted) {
                    entries.push(await this.entryToLogin(entry, kdbxDb));
                }
                return { entries };
            }

            case 'set-login': {
                const root = kdbxDb.getDefaultGroup();
                let entry: kdbxweb.KdbxEntry | undefined;
                if (payload.uuid) {
                    // A recycled entry is not one the browser may update; the
                    // write creates a new entry instead, as for an unknown uuid
                    const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
                    entry = [...this.allEntries(root, recycleBinUuid)].find(e => this.uuidHex(e.uuid) === payload.uuid);
                }

                // set-login carries no association key, so a rogue local
                // process could otherwise write or overwrite entries silently.
                // Gate on an explicit user confirmation (fail closed if the
                // host provides no way to ask)
                const consent = ctx.requestSetLoginConsent
                    ? await ctx.requestSetLoginConsent({
                        url: payload.url ?? '',
                        login: payload.login ?? '',
                        mode: entry ? 'update' : 'create',
                        entryTitle: entry
                            ? PlaceholderService.resolveKdbx(this.fieldString(entry.fields.get('Title')), entry, root)
                            : undefined,
                    })
                    : false;
                if (!consent) return { errorCode: ERROR_DENIED };

                if (entry) {
                    entry.pushHistory();
                    // Values rewritten outside any UI model: a save from a
                    // model built before this write must not push them back
                    KeepassDatabaseService.registerUnmodeledEdits([entry.uuid.toString()]);
                } else {
                    let group = root.groups.find(g => g.name === BROWSER_GROUP_NAME);
                    if (!group) {
                        group = kdbxDb.createGroup(root, BROWSER_GROUP_NAME);
                        KeepassDatabaseService.registerUnmodeledUuids([group.uuid.toString()]);
                    }
                    entry = kdbxDb.createEntry(group);
                    // Created outside any UI model: without this a save from
                    // a model built before this write would tombstone it
                    KeepassDatabaseService.registerUnmodeledUuids([entry.uuid.toString()]);
                    entry.fields.set('Title', this.hostOf(payload.url) || 'New entry');
                    entry.fields.set('URL', payload.url ?? '');
                }
                entry.fields.set('UserName', payload.login ?? '');
                entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(payload.password ?? ''));
                entry.times.lastModTime = new Date();
                try {
                    await ctx.saveDatabase();
                } catch {
                    // The write is in memory only; it rides the next successful
                    // save, but the extension must hear failure, not success
                    return { errorCode: ERROR_DENIED };
                }
                return { hash: await this.databaseHash(kdbxDb) };
            }

            // Passkey errors ride INSIDE the response object (KeePassXC shape:
            // { response: { errorCode } }); only association failures use the
            // protocol-level error envelope
            case 'passkeys-register': {
                if (!this.isAssociated(kdbxDb, payload.keys)) {
                    return { errorCode: ERROR_ASSOCIATION_FAILED };
                }
                const result = await PasskeyService.register(kdbxDb, payload.publicKey, payload.origin, payload.groupName, {
                    allowLocalhost: userSettingsService.getAllowPasskeysLocalhost(),
                    relatedOrigins: payload.relatedOrigins,
                });
                if (result.response.errorCode || !result.store) {
                    return { response: result.response };
                }
                const consent = await ctx.requestPasskeyConsent?.({
                    kind: 'register',
                    rpId: result.rpId!,
                    origin: payload.origin,
                    username: result.username,
                });
                if (!consent) {
                    return { response: { errorCode: PASSKEY_ERRORS.REQUEST_CANCELED } };
                }
                result.store();
                try {
                    await ctx.saveDatabase();
                } catch {
                    // Reporting success here while the private key never hit
                    // the disk would let the site complete a registration the
                    // user can never assert again. Fail the ceremony instead;
                    // the stored key stays in memory and is either persisted
                    // by a later save (a harmless orphan) or discarded
                    return { response: { errorCode: PASSKEY_ERRORS.UNKNOWN_ERROR } };
                }
                return { response: result.response };
            }

            case 'passkeys-get': {
                if (!this.isAssociated(kdbxDb, payload.keys)) {
                    return { errorCode: ERROR_ASSOCIATION_FAILED };
                }
                const allowed = await PasskeyService.allowedEntries(kdbxDb, payload.publicKey, payload.origin, {
                    allowLocalhost: userSettingsService.getAllowPasskeysLocalhost(),
                    relatedOrigins: payload.relatedOrigins,
                });
                if ('errorCode' in allowed) {
                    return { response: { errorCode: allowed.errorCode } };
                }
                const chosenId = await ctx.requestPasskeyConsent?.({
                    kind: 'get',
                    rpId: allowed.rpId,
                    origin: payload.origin,
                    entries: allowed.entries.map((e: PasskeyEntryInfo) => ({
                        title: e.title, username: e.username, credentialId: e.credentialId,
                    })),
                });
                const selected = allowed.entries.find(e => e.credentialId === chosenId);
                if (!selected) {
                    return { response: { errorCode: PASSKEY_ERRORS.REQUEST_CANCELED } };
                }
                const response = await PasskeyService.assert(selected, payload.publicKey, payload.origin, allowed.rpId);
                return { response };
            }

            case 'generate-password': {
                // Uses the generator settings the user last picked in the
                // generator modal (mode, length, character sets)
                const settings = PasswordGeneratorService.loadSettings();
                // Words mode needs the lazily loaded wordlist
                if (settings.mode === 'words') await PassphraseService.preload();
                const password = PasswordGeneratorService.generateFromSettings(settings);
                return { password, entries: [{ password }] };
            }

            case 'get-totp': {
                // Skips the recycle bin, as get-logins does: a deleted entry
                // must not keep handing out one-time codes
                const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
                const entry = [...this.allEntries(kdbxDb.getDefaultGroup(), recycleBinUuid)]
                    .find(e => this.uuidHex(e.uuid) === payload.uuid);
                if (!entry) return { errorCode: ERROR_NO_LOGINS_FOUND };
                // Only an entry get-logins released to the browser: a site the
                // user refused, or one that merely remembers a uuid from an
                // earlier grant, gets no code and burns no HOTP counter
                if (!this.isReleased(payload.uuid)) return { errorCode: ERROR_DENIED };
                const customFields = this.customFieldsOf(entry);
                const otpConfig = TotpService.getConfig(customFields);
                if (!otpConfig) return { errorCode: ERROR_NO_LOGINS_FOUND };
                let totp: string;
                try {
                    totp = await TotpService.generateCode(otpConfig);
                } catch {
                    return { errorCode: ERROR_NO_LOGINS_FOUND };
                }
                if (otpConfig.type === 'hotp') {
                    // The counter moves outside any UI model, as set-login
                    // does: lastModTime feeds the convert cache key, and the
                    // unmodeled-edit registration keeps a save from a stale
                    // model from pushing the old counter back. No history
                    // revision: one whose only difference is an older
                    // counter is a replay hazard on restore, not a credential
                    const next = TotpService.counterField(customFields, otpConfig.counter + 1);
                    if (next) {
                        const value = this.fieldString(next.value);
                        entry.fields.set(next.key, next.protected ? kdbxweb.ProtectedValue.fromString(value) : value);
                        entry.times.lastModTime = new Date();
                        KeepassDatabaseService.registerUnmodeledEdits([entry.uuid.toString()]);
                        // Not awaited: the code goes back whatever the save
                        // does (the bump is in memory and rides the next
                        // save; an error here would make the user burn
                        // another counter), and the extension's 5 s timeout
                        // must not depend on the KDF
                        ctx.saveDatabase().catch(() => {});
                    }
                }
                return { totp };
            }

            default:
                return { errorCode: 11 };
        }
    }
}

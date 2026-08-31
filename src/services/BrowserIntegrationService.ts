import * as kdbxweb from 'kdbxweb';
import { Database } from '../types/database';
import { TotpService } from './TotpService';
import { PasswordGeneratorService } from './PasswordGeneratorService';
import { PasskeyService, PasskeyEntryInfo, PASSKEY_ERRORS } from './PasskeyService';
import { userSettingsService } from './UserSettingsService';

// Renderer side of the KeePassXC-Browser protocol: answers the requests the
// main-process socket server forwards. Association keys are stored the way
// KeePassXC stores them (meta custom data, KPXC_BROWSER_<name> = base64 key),
// so a database keeps its browser pairings when moved between the two apps.

const ASSOCIATION_PREFIX = 'KPXC_BROWSER_';
const BROWSER_GROUP_NAME = 'Browser Passwords';

const ERROR_ASSOCIATION_FAILED = 8;
const ERROR_NO_LOGINS_FOUND = 15;
const ERROR_DENIED = 17;

export interface PasskeyConsentRequest {
    kind: 'register' | 'get';
    rpId: string;
    origin: string;
    username?: string;
    // get: matching credentials the user picks from
    entries?: Array<{ title: string; username: string; credentialId: string }>;
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
    // Shows the pairing dialog; resolves with the connection name or null
    requestPairing: (keyFingerprint: string) => Promise<string | null>;
    // Shows the passkey consent dialog; resolves with the chosen credentialId
    // ('register' resolves with any non-null value on approval), null on deny
    requestPasskeyConsent?: (request: PasskeyConsentRequest) => Promise<string | null>;
    // Shows the save-login confirmation; resolves true to allow the write.
    // The browser extension does not send association keys with set-login, so
    // this user confirmation is the gate (same as KeePassXC). When absent, the
    // write fails closed
    requestSetLoginConsent?: (request: SetLoginConsentRequest) => Promise<boolean>;
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

    static async databaseHash(kdbxDb: kdbxweb.Kdbx): Promise<string> {
        const uuidBytes = kdbxweb.ByteUtils.base64ToBytes(kdbxDb.getDefaultGroup().uuid.id);
        const digest = await crypto.subtle.digest('SHA-256', uuidBytes.slice().buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    static hostOf(url: string): string {
        try {
            return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
            return url.toLowerCase().replace(/^www\./, '');
        }
    }

    static urlMatches(entryUrl: string | undefined, requestUrl: string): boolean {
        if (!entryUrl) return false;
        const entryHost = this.hostOf(entryUrl);
        const requestHost = this.hostOf(requestUrl);
        if (!entryHost || !requestHost) return false;
        return entryHost === requestHost
            || entryHost.endsWith('.' + requestHost)
            || requestHost.endsWith('.' + entryHost);
    }

    private static uuidHex(uuid: kdbxweb.KdbxUuid): string {
        return [...kdbxweb.ByteUtils.base64ToBytes(uuid.id)]
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private static fieldString(value: string | kdbxweb.ProtectedValue | undefined): string {
        if (value === undefined) return '';
        return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
    }

    private static isAssociated(kdbxDb: kdbxweb.Kdbx, keys: Array<{ id: string; key: string }>): boolean {
        for (const { id, key } of keys ?? []) {
            const stored = kdbxDb.meta.customData.get(ASSOCIATION_PREFIX + id);
            if (stored?.value && stored.value === key) return true;
        }
        return false;
    }

    private static *allEntries(group: kdbxweb.KdbxGroup, recycleBinUuid?: string): Generator<kdbxweb.KdbxEntry> {
        if (recycleBinUuid && group.uuid.id === recycleBinUuid) return;
        for (const entry of group.entries) yield entry;
        for (const child of group.groups) yield* this.allEntries(child, recycleBinUuid);
    }

    private static async entryToLogin(entry: kdbxweb.KdbxEntry): Promise<any> {
        const login: any = {
            login: this.fieldString(entry.fields.get('UserName')),
            name: this.fieldString(entry.fields.get('Title')),
            password: this.fieldString(entry.fields.get('Password')),
            uuid: this.uuidHex(entry.uuid),
            group: entry.parentGroup?.name ?? '',
        };
        const customFields = [...entry.fields]
            .filter(([key]) => !['Title', 'UserName', 'Password', 'URL', 'Notes'].includes(key))
            .map(([key, value]) => ({ key, value, protected: value instanceof kdbxweb.ProtectedValue }));
        const totpConfig = TotpService.getConfig(customFields);
        if (totpConfig) {
            try {
                login.totp = await TotpService.generateCode(totpConfig);
            } catch {
                // unusable TOTP config; leave the field out
            }
        }
        return login;
    }

    static async handleRequest(action: string, payload: any, ctx: BrowserRequestContext): Promise<any> {
        const { kdbxDb } = ctx;
        switch (action) {
            case 'get-databasehash':
                return { hash: await this.databaseHash(kdbxDb) };

            case 'associate': {
                if (!payload.idKey) return { errorCode: ERROR_ASSOCIATION_FAILED };
                const fingerprint = String(payload.idKey).slice(0, 12);
                const name = await ctx.requestPairing(fingerprint);
                if (!name) return { errorCode: ERROR_DENIED };
                kdbxDb.meta.customData.set(ASSOCIATION_PREFIX + name, { value: payload.idKey });
                await ctx.saveDatabase();
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
                const entries: any[] = [];
                for (const entry of this.allEntries(kdbxDb.getDefaultGroup(), recycleBinUuid)) {
                    const url = this.fieldString(entry.fields.get('URL'));
                    if (this.urlMatches(url, payload.url)) {
                        entries.push(await this.entryToLogin(entry));
                    }
                }
                if (entries.length === 0) return { errorCode: ERROR_NO_LOGINS_FOUND };
                return { entries };
            }

            case 'set-login': {
                const root = kdbxDb.getDefaultGroup();
                let entry: kdbxweb.KdbxEntry | undefined;
                if (payload.uuid) {
                    entry = [...this.allEntries(root)].find(e => this.uuidHex(e.uuid) === payload.uuid);
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
                        entryTitle: entry ? this.fieldString(entry.fields.get('Title')) : undefined,
                    })
                    : false;
                if (!consent) return { errorCode: ERROR_DENIED };

                if (entry) {
                    entry.pushHistory();
                } else {
                    let group = root.groups.find(g => g.name === BROWSER_GROUP_NAME);
                    if (!group) group = kdbxDb.createGroup(root, BROWSER_GROUP_NAME);
                    entry = kdbxDb.createEntry(group);
                    entry.fields.set('Title', this.hostOf(payload.url) || 'New entry');
                    entry.fields.set('URL', payload.url ?? '');
                }
                entry.fields.set('UserName', payload.login ?? '');
                entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(payload.password ?? ''));
                entry.times.lastModTime = new Date();
                await ctx.saveDatabase();
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
                await ctx.saveDatabase();
                return { response: result.response };
            }

            case 'passkeys-get': {
                if (!this.isAssociated(kdbxDb, payload.keys)) {
                    return { errorCode: ERROR_ASSOCIATION_FAILED };
                }
                const allowed = PasskeyService.allowedEntries(kdbxDb, payload.publicKey, payload.origin, {
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
                const password = PasswordGeneratorService.generateFromSettings();
                return { password, entries: [{ password }] };
            }

            case 'get-totp': {
                const entry = [...this.allEntries(kdbxDb.getDefaultGroup())]
                    .find(e => this.uuidHex(e.uuid) === payload.uuid);
                if (!entry) return { errorCode: ERROR_NO_LOGINS_FOUND };
                const login = await this.entryToLogin(entry);
                if (!login.totp) return { errorCode: ERROR_NO_LOGINS_FOUND };
                return { totp: login.totp };
            }

            default:
                return { errorCode: 11 };
        }
    }
}

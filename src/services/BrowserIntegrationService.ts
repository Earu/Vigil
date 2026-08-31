import * as kdbxweb from 'kdbxweb';
import { Database } from '../types/database';
import { TotpService } from './TotpService';

// Renderer side of the KeePassXC-Browser protocol: answers the requests the
// main-process socket server forwards. Association keys are stored the way
// KeePassXC stores them (meta custom data, KPXC_BROWSER_<name> = base64 key),
// so a database keeps its browser pairings when moved between the two apps.

const ASSOCIATION_PREFIX = 'KPXC_BROWSER_';
const BROWSER_GROUP_NAME = 'Browser Passwords';

const ERROR_ASSOCIATION_FAILED = 8;
const ERROR_NO_LOGINS_FOUND = 15;
const ERROR_DENIED = 17;

export interface BrowserRequestContext {
    database: Database;
    kdbxDb: kdbxweb.Kdbx;
    saveDatabase: () => Promise<void>;
    // Shows the pairing dialog; resolves with the connection name or null
    requestPairing: (keyFingerprint: string) => Promise<string | null>;
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

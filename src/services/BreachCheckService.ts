import { HaveIBeenPwnedService } from './HaveIBeenPwnedService';
import { Entry, Group } from '../types/database';
import { BreachStatusStore } from './BreachStatusStore';
import { EmailBreachStatusStore } from './EmailBreachStatusStore';
import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { PlaceholderService } from './PlaceholderService';
import type { PasswordStrength } from './BreachStatusStore';

export interface HibpBreach {
    Name: string;
    Title: string;
    Domain: string;
    BreachDate: string;
    AddedDate: string;
    ModifiedDate: string;
    PwnCount: number;
    Description: string;
    LogoPath: string;
    DataClasses: string[];
    IsVerified: boolean;
    IsFabricated: boolean;
    IsSensitive: boolean;
    IsRetired: boolean;
    IsSpamList: boolean;
    IsMalware: boolean;
    IsSubscriptionFree: boolean;
}

export interface PasswordStatus {
    isPwned: boolean;
    pwnedCount: number;
    strength: {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    };
}

export interface BreachedEntry {
    entry: Entry;
    group: Group;
    count: number;
    strength?: {
        score: number;
        feedback: {
            warning: string;
            suggestions: string[];
        };
    };
}

export interface BreachCheckResult {
    breached: BreachedEntry[];
    weak: BreachedEntry[];
    hasCheckedEntries: boolean;
    allEntriesCached: boolean;
}

export interface EmailBreachResult {
    email: string;
    entryId: string;
    breaches: HibpBreach[];
}

export interface EmailCheckResult {
    checkedEmails: EmailBreachResult[];
    hasCheckedEmails: boolean;
    allEmailsCached: boolean;
}

export interface BreachedEmailEntry extends BreachedEntry {
    breaches: HibpBreach[];
    modified: Date;
}

export interface EmailBreachCheckResult {
    breached: BreachedEmailEntry[];
    hasCheckedEmails: boolean;
    allEmailsCached: boolean;
}

// Everything the sidebar needs about one group, for the whole subtree below
// it. The entry count rides along because computing it separately means a
// second full walk of the same tree for the same render
export interface GroupSummary {
    breached: boolean;
    weak: boolean;
    breachedEmail: boolean;
    entryCount: number;
}

// Entries that share one password. The password itself is only ever a map key
// inside findReusedPasswords and never reaches the report
export interface ReusedPasswordGroup {
    entries: Array<{ entry: Entry; group: Group }>;
    count: number;
}

export class BreachCheckService {
    // HIBP's k-anonymity range endpoint is explicitly not rate limited, so
    // password checks run with a small concurrency pool and no delay. The
    // email API IS rate limited; its delay below stays
    private static readonly PASSWORD_CONCURRENCY = 4;
    private static countedEntries: Set<string> = new Set();
    private static progress = { checked: 0, total: 0 };

    // Rate limiting: max 10 requests per minute for emails
    private static readonly EMAIL_REQUEST_DELAY = 6000; // 6 seconds between requests
    private static lastEmailRequestTime = 0;
    private static countedEmails: Set<string> = new Set();
    private static emailProgress = { checked: 0, total: 0 };
    private static toastId: string | null = null;

    // Cancellation support
    private static isCancelled = false;

    // Progress toasts are throttled: a mostly-cached sweep calls
    // incrementProgress once per entry in quick succession, and each toast
    // update is a React render cycle. Leading call paints immediately, a
    // trailing timer guarantees the last value lands. Completion,
    // cancellation and error paths render through renderProgressToast, which
    // bypasses the throttle
    private static readonly TOAST_THROTTLE_MS = 150;
    private static lastToastRender = 0;
    private static toastTrailingTimer: ReturnType<typeof setTimeout> | null = null;

    public static cancelChecks(): void {
        this.isCancelled = true;
        this.clearProgress();
        // Whatever the sweep already learned is worth keeping; a lock must not
        // throw away results that are still sitting in a coalesced write
        BreachStatusStore.flush();
        EmailBreachStatusStore.flush();
    }

    private static clearProgress(): void {
        this.countedEntries.clear();
        this.countedEmails.clear();
        this.progress = { checked: 0, total: 0 };
        this.emailProgress = { checked: 0, total: 0 };
        this.cancelTrailingToast();
        if (this.toastId) {
            (window as any).updateToast?.(this.toastId, {
                message: 'Breach check cancelled',
                type: 'info',
                duration: 3000
            });
            this.toastId = null;
        }
    }

    private static resetCancellation(): void {
        this.isCancelled = false;
        // Fresh sweep, fresh per-email dedup
        this.emailFetchCache.clear();
    }

    private static cancelTrailingToast(): void {
        if (this.toastTrailingTimer) {
            clearTimeout(this.toastTrailingTimer);
            this.toastTrailingTimer = null;
        }
    }

    // Throttled path for per-entry progress. At most one render per
    // TOAST_THROTTLE_MS; a burst schedules one trailing render so the final
    // value always lands
    private static updateProgressToast(): void {
        const elapsed = Date.now() - this.lastToastRender;
        if (elapsed >= this.TOAST_THROTTLE_MS) {
            this.renderProgressToast();
            return;
        }
        if (this.toastTrailingTimer) return;
        this.toastTrailingTimer = setTimeout(() => {
            this.toastTrailingTimer = null;
            this.renderProgressToast();
        }, this.TOAST_THROTTLE_MS - elapsed);
    }

    // Immediate render, no throttle. Terminal states (completed, zeroed
    // progress) call this directly so they never wait on the timer
    private static renderProgressToast(): void {
        this.cancelTrailingToast();
        this.lastToastRender = Date.now();
        const isCheckingPasswords = this.progress.total > 0;
        const isCheckingEmails = this.emailProgress.total > 0;

        if (!isCheckingPasswords && !isCheckingEmails) {
            if (this.toastId) {
                (window as any).updateToast?.(this.toastId, {
                    message: 'Breach check completed',
                    type: 'success',
                    duration: 3000
                });
                this.toastId = null;
            }
            return;
        }

        const message = isCheckingPasswords && isCheckingEmails
            ? `Checking database for breaches (${this.progress.checked}/${this.progress.total} passwords, ${this.emailProgress.checked}/${this.emailProgress.total} emails)`
            : isCheckingPasswords
                ? `Checking passwords for breaches (${this.progress.checked}/${this.progress.total})`
                : `Checking emails for breaches (${this.emailProgress.checked}/${this.emailProgress.total})`;

        if (!this.toastId) {
            this.toastId = (window as any).showToast?.({
                message,
                type: 'info',
                duration: 0 // Persistent until complete
            });
        } else {
            (window as any).updateToast?.(this.toastId, {
                message,
                type: 'info',
                duration: 0
            });
        }
    }

    private static incrementProgress(entryId: string): void {
        if (!this.countedEntries.has(entryId)) {
            this.countedEntries.add(entryId);
            this.progress.checked++;
            this.updateProgressToast();
        }
    }

    private static incrementEmailProgress(entryId: string): void {
        if (!this.countedEmails.has(entryId)) {
            this.countedEmails.add(entryId);
            this.emailProgress.checked++;
            this.updateProgressToast();
        }
    }

    public static getProgress(): { passwords: { checked: number; total: number }; emails: { checked: number; total: number } } {
        return {
            passwords: { ...this.progress },
            emails: { ...this.emailProgress }
        };
    }

    private static async checkPassword(password: string | kdbxweb.ProtectedValue): Promise<PasswordStatus> {
        const passwordString = typeof password === 'string' ? password : password.getText();
        return await HaveIBeenPwnedService.checkPassword(passwordString);
    }

    // Run tasks with a bounded number in flight; stops picking up new work
    // once cancelled
    private static async runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
        let next = 0;
        const lane = async () => {
            while (next < items.length && !this.isCancelled) {
                const item = items[next++];
                await worker(item);
            }
        };
        await Promise.all(Array.from(
            { length: Math.min(this.PASSWORD_CONCURRENCY, items.length) },
            () => lane()
        ));
    }

    private static countTotalEntries(group: Group): number {
        let total = group.entries.length;
        for (const subgroup of group.groups) {
            total += this.countTotalEntries(subgroup);
        }
        return total;
    }

    public static async checkEntry(databasePath: string, entry: Entry): Promise<boolean> {
        // No password (passkey-only entries): nothing to breach-check or
        // rate. Runs before the cache so stale flagged statuses get cleared
        const passwordString = typeof entry.password === 'string'
            ? entry.password
            : entry.password?.getText() ?? '';
        // Reference-valued passwords ({REF:P@...}) are pointers: hashing or
        // scoring the literal token says nothing, and the report hands the
        // verdict to the entry the reference points at instead
        if (!passwordString || PlaceholderService.hasReference(passwordString)) {
            const emailBreaches = EmailBreachStatusStore.getEntryEmailStatus(databasePath, entry.id, entry.username, entry.modified);
            BreachStatusStore.setEntryStatus(databasePath, entry.id, {
                isPwned: false,
                count: 0,
                strength: null,
                breachedEmail: emailBreaches !== null && emailBreaches.length > 0
            });
            this.incrementProgress(entry.id);
            return false;
        }

        // Check cache first
        const cachedStatus = BreachStatusStore.getEntryStatus(databasePath, entry.id);

        if (cachedStatus !== null) {
            this.incrementProgress(entry.id);
            return cachedStatus.isPwned;
        }

        // If not in cache or expired, check the password
        try {
            const result = await this.checkPassword(entry.password);
            const emailBreaches = EmailBreachStatusStore.getEntryEmailStatus(databasePath, entry.id, entry.username, entry.modified);
            BreachStatusStore.setEntryStatus(databasePath, entry.id, {
                isPwned: result.isPwned,
                count: result.pwnedCount,
                strength: result.strength,
                breachedEmail: emailBreaches !== null && emailBreaches.length > 0
            });
            this.incrementProgress(entry.id);

            return result.isPwned;
        } catch (error) {
            // Don't cache errors - we want to retry later
            this.incrementProgress(entry.id);
            throw error;
        }
    }

    // The group handed in is the sweep's root, whatever it is called. Root
    // setup and teardown live here rather than keying on the name 'All
    // Entries' (the synthetic label of the root model group): a real group
    // the user named that must not reset a running sweep's progress and
    // caches when the walk reaches it
    public static async checkGroup(databasePath: string, group: Group): Promise<boolean> {
        this.resetCancellation();
        const totalEntries = this.countTotalEntries(group);
        this.countedEntries.clear();
        this.progress = { checked: 0, total: totalEntries };
        this.updateProgressToast();

        try {
            const hasBreached = await this.walkGroup(databasePath, group);

            if (!this.isCancelled) {
                this.countedEntries.clear();
                this.progress = { checked: 0, total: 0 };
                this.renderProgressToast();
            }

            return hasBreached;
        } catch (error) {
            // Make sure we stop the status if there's an error
            this.clearProgress();
            throw error;
        } finally {
            // The sweep wrote one status per entry through the coalescing
            // timer; settle them however it ended
            BreachStatusStore.flush();
        }
    }

    private static async walkGroup(databasePath: string, group: Group): Promise<boolean> {
        let hasBreached = false;

        // Check entries with a small pool; the range API tolerates it
        await this.runPool(group.entries, async (entry) => {
            try {
                const isBreached = await this.checkEntry(databasePath, entry);
                hasBreached = hasBreached || isBreached;
            } catch (error) {
                // Continue checking other entries even if one fails
                console.error('Error checking entry:', error);
            }
        });
        if (this.isCancelled) {
            return false;
        }

        // Check subgroups one at a time
        for (const subgroup of group.groups) {
            if (this.isCancelled) {
                return false;
            }
            try {
                const isBreached = await this.walkGroup(databasePath, subgroup);
                hasBreached = hasBreached || isBreached;
            } catch (error) {
                // Continue checking other groups even if one fails
                console.error('Error checking group:', error);
            }
        }

        return hasBreached;
    }

    public static getEntryBreachStatus(databasePath: string, entryId: string): { isPwned: boolean; count: number; strength: PasswordStrength | null; breachedEmail?: boolean } | null {
        return BreachStatusStore.getEntryStatus(databasePath, entryId);
    }

    // One bottom-up pass over the whole tree, keyed by group id. The sidebar
    // used to ask each group node three separate "does this subtree contain
    // X" questions, so a status update cost O(depth * entries) traversals per
    // indicator; the answers for every group now come out of a single walk
    public static buildGroupSummaries(root: Group): Map<string, GroupSummary> {
        const summaries = new Map<string, GroupSummary>();
        const databasePath = KeepassDatabaseService.getPath();

        const walk = (group: Group): GroupSummary => {
            const summary: GroupSummary = {
                breached: false,
                weak: false,
                breachedEmail: false,
                entryCount: group.entries.length,
            };

            if (databasePath) {
                for (const entry of group.entries) {
                    const status = BreachStatusStore.getEntryStatus(databasePath, entry.id);
                    if (!status) continue;
                    // An exposed email is worth flagging even on a passkey-only
                    // entry; a breached or weak password needs a password
                    if (status.breachedEmail) summary.breachedEmail = true;
                    if (!this.entryHasPassword(entry)) continue;
                    if (status.isPwned) summary.breached = true;
                    if (status.strength && status.strength.score < 3) summary.weak = true;
                }
            }

            for (const subgroup of group.groups) {
                const child = walk(subgroup);
                summary.breached = summary.breached || child.breached;
                summary.weak = summary.weak || child.weak;
                summary.breachedEmail = summary.breachedEmail || child.breachedEmail;
                // Matches countEntriesInGroup: the bin's contents are not part
                // of its parents' totals, but the bin's own row still counts them
                if (!subgroup.isRecycleBin) summary.entryCount += child.entryCount;
            }

            summaries.set(group.id, summary);
            return summary;
        };

        walk(root);
        return summaries;
    }

    // cyrb53: fast 53-bit string hash, two imul lanes. Non-cryptographic on
    // purpose: it only buckets candidates, real equality is confirmed on the
    // decrypted text before anything is reported
    private static cyrb53(text: string): string {
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
    }

    // Password hash keyed by the entry model object, so an unchanged model
    // never re-decrypts its ProtectedValue. Only the hash is retained, never
    // the text; '' means no password. Models are rebuilt on save, so a stale
    // object simply stops being asked. Entry identity currently changes on
    // every rebuild; the cache is correct regardless and pays off more once
    // identities become stable
    private static passwordHashCache = new WeakMap<Entry, { hash: string; isReference: boolean }>();

    // One decrypt yields both facts the walks need: the reuse hash and
    // whether the password is a {REF:...} pointer
    private static passwordInfo(entry: Entry): { hash: string; isReference: boolean } {
        const cached = this.passwordHashCache.get(entry);
        if (cached !== undefined) return cached;
        const text = entry.password ? KeepassDatabaseService.getPasswordString(entry.password) : '';
        const info = {
            hash: text ? this.cyrb53(text) : '',
            isReference: PlaceholderService.hasReference(text),
        };
        this.passwordHashCache.set(entry, info);
        return info;
    }

    private static passwordHasReference(entry: Entry): boolean {
        return this.passwordInfo(entry).isReference;
    }

    // Purely local: no network, no cached status, so this works the moment a
    // vault is open. Recycle bin contents are left out, the way expiry is.
    // Buckets by cached hash first; only buckets with more than one member
    // decrypt their few entries to confirm true equality, so a full-vault
    // call decrypts almost nothing after the first pass
    public static findReusedPasswords(root: Group): ReusedPasswordGroup[] {
        const byHash = new Map<string, Array<{ entry: Entry; group: Group }>>();

        const walk = (group: Group) => {
            if (group.isRecycleBin) return;
            for (const entry of group.entries) {
                // A reference is the sanctioned way to share one password;
                // flagging it as reuse would tell users to stop doing the
                // right thing. Referrers of the same target share the same
                // literal token, so without this they would cluster
                const { hash, isReference } = this.passwordInfo(entry);
                if (isReference || !hash) continue;
                const bucket = byHash.get(hash);
                if (bucket) bucket.push({ entry, group });
                else byHash.set(hash, [{ entry, group }]);
            }
            group.groups.forEach(walk);
        };
        walk(root);

        const clusters: ReusedPasswordGroup[] = [];
        for (const bucket of byHash.values()) {
            if (bucket.length < 2) continue;
            // A shared hash is only a candidate: confirm on the real text so
            // a collision never reports a false pair. The text stays local
            const byText = new Map<string, Array<{ entry: Entry; group: Group }>>();
            for (const item of bucket) {
                const text = KeepassDatabaseService.getPasswordString(item.entry.password);
                const sub = byText.get(text);
                if (sub) sub.push(item);
                else byText.set(text, [item]);
            }
            for (const sub of byText.values()) {
                if (sub.length > 1) clusters.push({ entries: sub, count: sub.length });
            }
        }

        // Widest reuse first, then by title so the order is stable across
        // renders (Map iteration order alone would follow insertion)
        return clusters.sort((a, b) =>
            b.count - a.count ||
            a.entries[0].entry.title.localeCompare(b.entries[0].entry.title)
        );
    }

    public static clearCache(databasePath: string): void {
        BreachStatusStore.clearDatabase(databasePath);
    }

    public static findBreachedAndWeakEntries(group: Group, parentGroup: Group = group): BreachCheckResult {
        const databasePath = KeepassDatabaseService.getPath();
        if (!databasePath) return {
            breached: [],
            weak: [],
            hasCheckedEntries: false,
            allEntriesCached: false
        };

        const breached: BreachedEntry[] = [];
        const weak: BreachedEntry[] = [];
        let hasCheckedEntries = false;
        let allEntriesCached = true;

        // Check entries in current group
        group.entries.forEach(entry => {
            // Passwordless entries (passkey-only) have no password to flag,
            // whatever a stale cached status says
            if (!this.entryHasPassword(entry)) return;

            // A reference-valued password inherits the verdict of the entry
            // it points at: never scored itself, but flagged alongside its
            // target so rotating the one real password clears both
            if (this.passwordHasReference(entry)) {
                const root = PlaceholderService.getModelRoot();
                const target = root ? PlaceholderService.findPasswordTargetEntry(entry, root) : null;
                if (target) {
                    const targetStatus = BreachStatusStore.getEntryStatus(databasePath, target.id);
                    const entryInfo = {
                        entry,
                        group: parentGroup,
                        count: targetStatus?.count ?? 0,
                        strength: targetStatus?.strength ?? undefined
                    };
                    if (targetStatus?.isPwned) breached.push(entryInfo);
                    if (targetStatus?.strength && targetStatus.strength.score < 3) weak.push(entryInfo);
                }
                return;
            }

            const status = BreachStatusStore.getEntryStatus(databasePath, entry.id);
            hasCheckedEntries = true;

            if (status === null) {
                allEntriesCached = false;
                return;
            }

            const entryInfo = {
                entry,
                group: parentGroup,
                count: status.count,
                strength: status.strength ?? undefined
            };

            if (status.isPwned) {
                breached.push(entryInfo);
            }

            if (status.strength && status.strength.score < 3) {
                weak.push(entryInfo);
            }
        });

        // Check subgroups
        group.groups.forEach(subgroup => {
            const subResults = this.findBreachedAndWeakEntries(subgroup, subgroup);
            breached.push(...subResults.breached);
            weak.push(...subResults.weak);
            hasCheckedEntries = hasCheckedEntries || subResults.hasCheckedEntries;
            allEntriesCached = allEntriesCached && subResults.allEntriesCached;
        });

        return {
            breached,
            weak,
            hasCheckedEntries,
            allEntriesCached
        };
    }

    // Cached per password object: the summary and report walks run on every
    // store tick during a sweep, and decrypting every ProtectedValue each
    // time made those ticks cost a full vault of AES work. Only the boolean
    // is kept, never the decrypted text, and the model is rebuilt on every
    // save so a stale object simply stops being asked
    private static hasPasswordCache = new WeakMap<object, boolean>();

    private static entryHasPassword(entry: Entry): boolean {
        const password = entry.password;
        if (!password) return false;
        if (typeof password === 'string') return password.length > 0;
        const cached = this.hasPasswordCache.get(password);
        if (cached !== undefined) return cached;
        const has = !!KeepassDatabaseService.getPasswordString(password);
        this.hasPasswordCache.set(password, has);
        return has;
    }

    private static isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    // Raw (unfiltered) breach lists per email address, shared across entries
    // within a sweep: many entries share one email, and each API call costs
    // 6 seconds of rate-limit budget
    private static emailFetchCache = new Map<string, Promise<HibpBreach[] | null>>();

    private static fetchEmailBreaches(email: string): Promise<HibpBreach[] | null> {
        const cached = this.emailFetchCache.get(email);
        if (cached) return cached;
        const request = (async () => {
            // The breachedaccount API is rate limited per key tier; space
            // out actual fetches (dedup hits skip this entirely)
            const sinceLast = Date.now() - this.lastEmailRequestTime;
            if (sinceLast < this.EMAIL_REQUEST_DELAY) {
                await new Promise(resolve => setTimeout(resolve, this.EMAIL_REQUEST_DELAY - sinceLast));
            }
            this.lastEmailRequestTime = Date.now();
            return await HaveIBeenPwnedService.checkEmailBreaches(email);
        })();
        this.emailFetchCache.set(email, request);
        return request;
    }

    private static async checkEmailEntry(databasePath: string, entry: Entry): Promise<HibpBreach[]> {
        if (!this.isValidEmail(entry.username)) {
            return [];
        }

        // Check cache first
        const cachedStatus = EmailBreachStatusStore.getEntryEmailStatus(databasePath, entry.id, entry.username, entry.modified);

        if (cachedStatus !== null) {
            this.incrementEmailProgress(entry.id);
            return cachedStatus;
        }

        const raw = await this.fetchEmailBreaches(entry.username);
        this.incrementEmailProgress(entry.id);
        if (raw === null) {
            // Failed lookup: report nothing and leave it uncached so the
            // next sweep retries instead of trusting a false all-clear
            return [];
        }

        // Cached unfiltered: the address's list serves every entry that
        // carries it, each with its own last-change date
        EmailBreachStatusStore.setEntryEmailStatus(databasePath, entry.id, entry.username, raw);
        return EmailBreachStatusStore.relevantBreaches(raw, entry.modified);
    }

    // Root setup and teardown, like checkGroup's: never keyed on the group's
    // name, the group handed in IS the root of this sweep
    public static async checkGroupEmails(databasePath: string, group: Group): Promise<boolean> {
        this.resetCancellation();
        const totalEntries = this.countTotalEntries(group);
        this.countedEmails.clear();
        this.emailProgress = { checked: 0, total: totalEntries };
        this.updateProgressToast();

        try {
            const hasBreached = await this.walkGroupEmails(databasePath, group);

            if (!this.isCancelled) {
                this.countedEmails.clear();
                this.emailProgress = { checked: 0, total: 0 };
                this.renderProgressToast();
            }

            return hasBreached;
        } catch (error) {
            // Make sure we stop the status if there's an error
            this.clearProgress();
            throw error;
        } finally {
            // This sweep writes to both stores: breach statuses pick up the
            // breachedEmail flag as email results land
            EmailBreachStatusStore.flush();
            BreachStatusStore.flush();
        }
    }

    private static async walkGroupEmails(databasePath: string, group: Group): Promise<boolean> {
        let hasBreached = false;

        // Check entries one at a time to respect rate limits
        for (const entry of group.entries) {
            if (this.isCancelled) {
                return false;
            }
            if (this.isValidEmail(entry.username)) {
                try {
                    const breaches = await this.checkEmailEntry(databasePath, entry);
                    if (breaches.length > 0) {
                        // Merge breachedEmail into an existing password verdict
                        // only. Fabricating a record here would count as a cache
                        // hit in checkEntry and skip the real password check for
                        // the TTL; with no record yet, checkEntry reads the
                        // email store itself when it writes its verdict
                        const currentStatus = BreachStatusStore.getEntryStatus(databasePath, entry.id);
                        if (currentStatus !== null) {
                            BreachStatusStore.setEntryStatus(databasePath, entry.id, {
                                ...currentStatus,
                                breachedEmail: true
                            });
                        }
                    }
                    hasBreached = hasBreached || breaches.length > 0;
                } catch (error) {
                    // Continue checking other entries even if one fails
                    console.error('Error checking email entry:', error);
                }
            } else {
                // Skip non-email entries but still count them for progress
                this.incrementEmailProgress(entry.id);
            }
        }

        // Check subgroups one at a time
        for (const subgroup of group.groups) {
            if (this.isCancelled) {
                return false;
            }
            try {
                const isBreached = await this.walkGroupEmails(databasePath, subgroup);
                hasBreached = hasBreached || isBreached;
            } catch (error) {
                // Continue checking other groups even if one fails
                console.error('Error checking group:', error);
            }
        }

        return hasBreached;
    }

    public static findBreachedEmails(group: Group, parentGroup: Group = group): EmailBreachCheckResult {
        const databasePath = KeepassDatabaseService.getPath();
        if (!databasePath) return {
            breached: [],
            hasCheckedEmails: false,
            allEmailsCached: false
        };

        const breached: BreachedEmailEntry[] = [];
        let hasCheckedEmails = false;
        let allEmailsCached = true;

        // Check entries in current group
        group.entries.forEach(entry => {
            if (!this.isValidEmail(entry.username)) {
                return;
            }

            const breaches = EmailBreachStatusStore.getEntryEmailStatus(databasePath, entry.id, entry.username, entry.modified);
            hasCheckedEmails = true;

            if (breaches === null) {
                allEmailsCached = false;
                return;
            }

            if (breaches.length > 0) {
                const entryInfo: BreachedEmailEntry = {
                    entry,
                    group: parentGroup,
                    count: breaches.length,
                    breaches,
                    modified: entry.modified
                };

                // Check if any breach is newer than the entry's last modification
                const hasRecentBreach = breaches.some(breach => {
                    const breachDate = new Date(breach.BreachDate);
                    return breachDate > entry.modified;
                });

                if (hasRecentBreach) {
                    breached.push(entryInfo);
                }
            }
        });

        // Check subgroups
        group.groups.forEach(subgroup => {
            const subResults = this.findBreachedEmails(subgroup, subgroup);
            breached.push(...subResults.breached);
            hasCheckedEmails = hasCheckedEmails || subResults.hasCheckedEmails;
            allEmailsCached = allEmailsCached && subResults.allEmailsCached;
        });

        return {
            breached,
            hasCheckedEmails,
            allEmailsCached
        };
    }
}
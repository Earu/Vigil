import * as kdbxweb from 'kdbxweb';
import { Database } from '../types/database';
import { BrowserIntegrationService } from './BrowserIntegrationService';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import { userSettingsService } from './UserSettingsService';

// Favicon promotion: an entry showing a fetched favicon gets that image
// written into the database as a KeePass custom icon, after which every
// client (this one included) renders the stored icon and the network fetch
// stops. One attempt per host per session; a host that fails is left for a
// later session rather than retried in a loop.
//
// The writes go straight onto the kdbx objects, the same way the browser
// extension's set-login does: pushHistory first so a merge losing to the
// bumped timestamp still holds the pre-icon state in history, and the entry
// registered as an unmodeled edit so a save from a model built before the
// write cannot push the icon back off. Each promoted host saves immediately,
// which converts a fresh model and closes its ledger entries: the window in
// which a user save of the same entry would be frozen out stays as narrow
// as the browser write path's, instead of spanning the whole sweep.
//
// A sweep can outlive the vault it started on (fetches take seconds to
// minutes), so every write and save is gated on a generation token. Locking
// bumps it via reset(), and a stale sweep then stops dead: without that, its
// save callback would put the decrypted model back on screen after the lock.

const MAX_HOSTS_PER_SWEEP = 50;
const FETCH_CONCURRENCY = 4;

export class FaviconService {
    // Hosts attempted this session, successful or not
    private static attempted = new Set<string>();
    private static sweepInFlight = false;
    // Bumped by reset(); a sweep only writes while its captured value matches
    private static generation = 0;

    // Lock, vault close, and tests: stop any running sweep at its next
    // checkpoint and start the next session clean
    static reset(): void {
        this.generation++;
        this.attempted.clear();
        this.sweepInFlight = false;
    }

    // The user asked for this site's favicon back (cleared the opt-out), so
    // the once-per-session guard steps aside for its host
    static forget(url: string): void {
        this.attempted.delete(BrowserIntegrationService.hostOf(url));
    }

    // blocked is consulted before each host's writes: an edit or save that
    // began after the sweep started stops it early, and the unwritten hosts
    // are handed back so the next sweep picks them up
    static async sweep(
        kdbxDb: kdbxweb.Kdbx,
        database: Database,
        saveDatabase: () => Promise<void>,
        blocked?: () => boolean
    ): Promise<void> {
        if (this.sweepInFlight) return;
        if (!userSettingsService.getFetchFavicons()) return;
        if (!window.electron?.fetchFavicon) return;

        // Entries still rendering off the network, grouped by host
        const byHost = new Map<string, string[]>();
        for (const entry of KeepassDatabaseService.getAllEntriesFromGroup(database.root)) {
            // A stored custom icon means promotion already ran (or the user
            // picked an image); a chosen standard icon is a choice too, and
            // promotion must not paint over it. suppressFavicon is the
            // explicit opt-out left behind by removing a favicon icon
            if (!entry.url || entry.customIcon || entry.icon || entry.suppressFavicon) continue;
            const host = BrowserIntegrationService.hostOf(entry.url);
            if (!host || !host.includes('.') || this.attempted.has(host)) continue;
            const ids = byHost.get(host) ?? [];
            ids.push(entry.id);
            byHost.set(host, ids);
        }
        if (byHost.size === 0) return;

        this.sweepInFlight = true;
        const generation = this.generation;
        try {
            const kdbxEntries = new Map<string, kdbxweb.KdbxEntry>();
            for (const entry of kdbxDb.getDefaultGroup().allEntries()) {
                kdbxEntries.set(entry.uuid.toString(), entry);
            }

            const hosts = [...byHost].slice(0, MAX_HOSTS_PER_SWEEP);

            // Fetches run a few at a time; writes and saves stay serial, in
            // host order, so each checkpoint sees settled state
            const fetchOne = async (host: string): Promise<Uint8Array | null> => {
                this.attempted.add(host);
                try {
                    const result = await window.electron!.fetchFavicon(host);
                    if (result?.success && result.data) return new Uint8Array(result.data);
                } catch { /* leave the host for a later session */ }
                return null;
            };
            const inFlight = new Map<string, Promise<Uint8Array | null>>();
            let nextToFetch = 0;
            const fillPool = () => {
                while (inFlight.size < FETCH_CONCURRENCY && nextToFetch < hosts.length) {
                    const [host] = hosts[nextToFetch++];
                    inFlight.set(host, fetchOne(host));
                }
            };
            fillPool();

            for (let i = 0; i < hosts.length; i++) {
                const [host, entryIds] = hosts[i];
                const bytes = await inFlight.get(host)!;
                inFlight.delete(host);
                fillPool();

                if (generation !== this.generation) return;
                if (blocked?.()) {
                    // Not this session's turn: give the remaining hosts back
                    for (let j = i; j < hosts.length; j++) this.attempted.delete(hosts[j][0]);
                    return;
                }
                if (!bytes) continue;

                const iconId = KeepassDatabaseService.ensureCustomIcon(kdbxDb, bytes);
                let promoted = false;
                for (const entryId of entryIds) {
                    const kdbxEntry = kdbxEntries.get(entryId);
                    if (!kdbxEntry || kdbxEntry.customIcon) continue;
                    kdbxEntry.pushHistory();
                    kdbxEntry.customIcon = new kdbxweb.KdbxUuid(iconId);
                    kdbxEntry.times.lastModTime = new Date();
                    KeepassDatabaseService.registerUnmodeledEdits([entryId]);
                    promoted = true;
                }
                if (promoted) {
                    try {
                        await saveDatabase();
                    } catch {
                        // The icons hold in memory and ride the next save
                    }
                    if (generation !== this.generation) return;
                }
            }
        } finally {
            // A reset() mid-sweep may have let a new sweep start; only the
            // generation that set the flag may clear it
            if (generation === this.generation) this.sweepInFlight = false;
        }
    }
}

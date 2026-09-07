import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getPublicSuffix } from 'tldts';
import { BrowserIntegrationService as Svc } from '../../src/services/BrowserIntegrationService';
import { isPublicSuffix } from '../../src/services/PublicSuffix';
import { settings, anyText } from './fuzz';

// urlMatches decides which stored credentials a site is offered. The
// properties below are the ones that, broken, hand a login to the wrong
// site: an unrelated host, a parent of the entry's host, a downgraded scheme,
// a stranger who registered under the same public suffix

const host = fc.domain().map(h => h.toLowerCase());
const scheme = fc.constantFrom('https', 'http');

describe('URL matching under fuzz', () => {
    it('never throws, whatever the entry URL or the request URL is', async () => {
        await fc.assert(fc.asyncProperty(anyText(), anyText(), async (entry, site) => {
            expect(typeof await Svc.urlMatches(entry, site)).toBe('boolean');
            expect(typeof Svc.hostOf(site)).toBe('string');
            expect(typeof Svc.decisionHost(site)).toBe('string');
        }), settings());
    });

    it('a match means the site is the entry host or a subdomain of it, never the reverse', async () => {
        await fc.assert(fc.asyncProperty(host, host, async (entryHost, siteHost) => {
            const matched = await Svc.urlMatches(`https://${entryHost}/`, `https://${siteHost}/`);
            const strip = (h: string) => h.replace(/^www\./, '');
            const e = strip(entryHost);
            const s = strip(siteHost);
            // The subdomain half holds only where the entry host is a name one
            // party controls; under a public suffix it is a stranger's
            const related = s === e || (s.endsWith('.' + e) && !await isPublicSuffix(e));
            expect(matched).toBe(related);
        }), settings());
    });

    it('an entry for a subdomain is never offered on its parent', async () => {
        await fc.assert(fc.asyncProperty(host, fc.stringMatching(/^[a-z0-9]{1,8}$/), async (parent, label) => {
            expect(await Svc.urlMatches(`https://${label}.${parent}/`, `https://${parent}/`)).toBe(false);
        }), settings());
    });

    it('a host that merely ends with the entry host is not a subdomain of it', async () => {
        await fc.assert(fc.asyncProperty(host, fc.stringMatching(/^[a-z0-9]{1,8}$/), async (entryHost, prefix) => {
            expect(await Svc.urlMatches(`https://${entryHost}/`, `https://${prefix}${entryHost}/`)).toBe(false);
        }), settings());
    });

    // An entry stored against a name anyone can register under gets the exact
    // match and nothing else, so one tenant is never offered another's login.
    // The suffix is taken from the generated host rather than filtered for,
    // which would reject almost every domain fc.domain() produces
    it('a public suffix entry is never offered to anything registered under it', async () => {
        await fc.assert(fc.asyncProperty(host, async (siteHost) => {
            const stripped = siteHost.replace(/^www\./, '');
            const suffix = getPublicSuffix(stripped, { allowPrivateDomains: true });
            // Only where the site really sits under the suffix, so the pair
            // being checked is a stranger's registration and not the entry's
            // own exact match
            fc.pre(suffix !== null && suffix !== stripped);
            expect(await isPublicSuffix(suffix!)).toBe(true);
            expect(await Svc.urlMatches(`https://${suffix}/`, `https://${siteHost}/`)).toBe(false);
            // What the entry does keep: the suffix itself
            expect(await Svc.urlMatches(`https://${suffix}/`, `https://${suffix}/`)).toBe(true);
        }), settings());
    });

    it('an https entry is never handed to an http page, and a named port must agree', async () => {
        await fc.assert(fc.asyncProperty(host, scheme, scheme, fc.integer({ min: 1, max: 65535 }), fc.integer({ min: 1, max: 65535 }), async (h, entryScheme, siteScheme, entryPort, sitePort) => {
            if (entryScheme !== siteScheme) {
                expect(await Svc.urlMatches(`${entryScheme}://${h}/`, `${siteScheme}://${h}/`)).toBe(false);
            }
            if (entryPort !== sitePort) {
                expect(await Svc.urlMatches(`https://${h}:${entryPort}/`, `https://${h}:${sitePort}/`)).toBe(false);
            }
        }), settings());
    });

    it('userinfo, paths and fragments in the request never change which host is matched', async () => {
        await fc.assert(fc.asyncProperty(host, host, fc.stringMatching(/^[a-z0-9]{1,10}$/), fc.stringMatching(/^[a-z0-9/._-]{0,20}$/), async (entryHost, decoy, user, rest) => {
            const plain = await Svc.urlMatches(`https://${entryHost}/`, `https://${decoy}/`);
            const dressed = await Svc.urlMatches(`https://${entryHost}/`, `https://${user}@${decoy}/${rest}#${entryHost}`);
            expect(dressed).toBe(plain);
            expect(Svc.decisionHost(`https://${user}@${decoy}/${rest}#${entryHost}`)).toBe(decoy);
        }), settings());
    });
});

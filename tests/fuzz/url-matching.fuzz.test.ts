import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { BrowserIntegrationService as Svc } from '../../src/services/BrowserIntegrationService';
import { settings, anyText } from './fuzz';

// urlMatches decides which stored credentials a site is offered. The
// properties below are the ones that, broken, hand a login to the wrong
// site: an unrelated host, a parent of the entry's host, a downgraded scheme

const host = fc.domain().map(h => h.toLowerCase());
const scheme = fc.constantFrom('https', 'http');

describe('URL matching under fuzz', () => {
    it('never throws, whatever the entry URL or the request URL is', () => {
        fc.assert(fc.property(anyText(), anyText(), (entry, site) => {
            expect(typeof Svc.urlMatches(entry, site)).toBe('boolean');
            expect(typeof Svc.hostOf(site)).toBe('string');
            expect(typeof Svc.decisionHost(site)).toBe('string');
        }), settings());
    });

    it('a match means the site is the entry host or a subdomain of it, never the reverse', () => {
        fc.assert(fc.property(host, host, (entryHost, siteHost) => {
            const matched = Svc.urlMatches(`https://${entryHost}/`, `https://${siteHost}/`);
            const strip = (h: string) => h.replace(/^www\./, '');
            const e = strip(entryHost);
            const s = strip(siteHost);
            const related = s === e || s.endsWith('.' + e);
            expect(matched).toBe(related);
        }), settings());
    });

    it('an entry for a subdomain is never offered on its parent', () => {
        fc.assert(fc.property(host, fc.stringMatching(/^[a-z0-9]{1,8}$/), (parent, label) => {
            expect(Svc.urlMatches(`https://${label}.${parent}/`, `https://${parent}/`)).toBe(false);
        }), settings());
    });

    it('a host that merely ends with the entry host is not a subdomain of it', () => {
        fc.assert(fc.property(host, fc.stringMatching(/^[a-z0-9]{1,8}$/), (entryHost, prefix) => {
            expect(Svc.urlMatches(`https://${entryHost}/`, `https://${prefix}${entryHost}/`)).toBe(false);
        }), settings());
    });

    it('an https entry is never handed to an http page, and a named port must agree', () => {
        fc.assert(fc.property(host, scheme, scheme, fc.integer({ min: 1, max: 65535 }), fc.integer({ min: 1, max: 65535 }), (h, entryScheme, siteScheme, entryPort, sitePort) => {
            if (entryScheme !== siteScheme) {
                expect(Svc.urlMatches(`${entryScheme}://${h}/`, `${siteScheme}://${h}/`)).toBe(false);
            }
            if (entryPort !== sitePort) {
                expect(Svc.urlMatches(`https://${h}:${entryPort}/`, `https://${h}:${sitePort}/`)).toBe(false);
            }
        }), settings());
    });

    it('userinfo, paths and fragments in the request never change which host is matched', () => {
        fc.assert(fc.property(host, host, fc.stringMatching(/^[a-z0-9]{1,10}$/), fc.stringMatching(/^[a-z0-9/._-]{0,20}$/), (entryHost, decoy, user, rest) => {
            const plain = Svc.urlMatches(`https://${entryHost}/`, `https://${decoy}/`);
            const dressed = Svc.urlMatches(`https://${entryHost}/`, `https://${user}@${decoy}/${rest}#${entryHost}`);
            expect(dressed).toBe(plain);
            expect(Svc.decisionHost(`https://${user}@${decoy}/${rest}#${entryHost}`)).toBe(decoy);
        }), settings());
    });
});

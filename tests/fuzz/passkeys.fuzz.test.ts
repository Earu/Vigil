import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as kdbxweb from 'kdbxweb';
import { cred } from '../helpers';
import { PasskeyService, validateRpId, isPublicSuffix, b64urlEncode, PASSKEY_ERRORS } from '../../src/services/PasskeyService';
import { settings, anyText, anyValue } from './fuzz';

// The WebAuthn options arrive from a web page by way of the extension. They
// are the most attacker-shaped input in the app: any shape must come back as
// an error code, and the RP ID rule must hold for every domain pair

const db = () => {
    const created = kdbxweb.Kdbx.create(cred(), 'Vault');
    created.setVersion(4);
    return created;
};

const challenge = b64urlEncode(new Uint8Array(32).fill(7));
const domain = fc.domain().map(d => d.toLowerCase());

// Options that are nearly right, so the fuzz reaches past the first check
const nearlyValidOptions = fc.record({
    challenge: fc.oneof(fc.constant(challenge), anyText(), anyValue()),
    rp: fc.oneof(fc.record({ id: fc.oneof(domain, anyText()), name: anyText() }), anyValue()),
    user: fc.oneof(fc.record({ id: fc.oneof(fc.constant(b64urlEncode(new Uint8Array([1, 2, 3]))), anyText()), name: anyText() }), anyValue()),
    pubKeyCredParams: fc.oneof(
        fc.array(fc.record({ type: fc.oneof(fc.constant('public-key'), anyText()), alg: fc.oneof(fc.constantFrom(-7, -8, -257), fc.integer()) })),
        anyValue(),
    ),
    excludeCredentials: fc.oneof(fc.array(fc.record({ id: anyText() })), anyValue()),
    allowCredentials: fc.oneof(fc.array(fc.record({ type: anyText(), id: anyText() })), anyValue()),
    rpId: fc.oneof(domain, anyText(), fc.constant(undefined)),
}, { requiredKeys: [] });

const origin = fc.oneof(
    domain.map(d => `https://${d}`),
    domain.map(d => `http://${d}`),
    fc.constant('https://localhost'),
    anyText(),
);

describe('passkey ceremonies under fuzz', () => {
    it('register answers with a response object for any options and origin, never rejects', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(nearlyValidOptions, anyValue()), origin, async (options, from) => {
            const result = await PasskeyService.register(db(), options, from, undefined);
            expect(typeof result.response).toBe('object');
            if (result.response.errorCode !== undefined) {
                expect(Object.values(PASSKEY_ERRORS)).toContain(result.response.errorCode);
            } else {
                expect(typeof result.store).toBe('function');
            }
        }), settings({ numRuns: Math.min(settings().numRuns!, 400) }));
    });

    it('allowedEntries answers for any options and origin, never rejects', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(nearlyValidOptions, anyValue()), origin, async (options, from) => {
            const result = await PasskeyService.allowedEntries(db(), options, from);
            expect(typeof result).toBe('object');
            if ('errorCode' in result) expect(Object.values(PASSKEY_ERRORS)).toContain(result.errorCode);
        }), settings({ numRuns: Math.min(settings().numRuns!, 400) }));
    });

    it('an accepted RP ID is the domain itself or a registrable suffix of it', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(domain, anyText()), domain, async (rpId, site) => {
            const accepted = await validateRpId(rpId, site);
            if (accepted === null) return;
            // No rpId at all means the origin's own domain, as WebAuthn says
            if (!rpId) {
                expect(accepted).toBe(site);
                return;
            }
            expect(accepted).toBe(rpId.toLowerCase());
            if (accepted !== site) {
                expect(site.endsWith('.' + accepted)).toBe(true);
                expect(await isPublicSuffix(accepted)).toBe(false);
            }
        }), settings());
    });

    it('a related-origins list can only vouch for the caller it names', async () => {
        await fc.assert(fc.asyncProperty(domain, domain, fc.array(domain, { maxLength: 4 }), async (rpId, caller, listed) => {
            fc.pre(rpId !== caller && !caller.endsWith('.' + rpId));
            fc.pre(await isPublicSuffix(rpId) === false);
            const origins = listed.map(d => `https://${d}`);
            const accepted = await validateRpId(rpId, caller, `https://${caller}`, origins);
            expect(accepted !== null).toBe(listed.includes(caller));
        }), settings());
    });

    it('only https origins pass without the localhost opt-in', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(domain.map(d => `http://${d}`), anyText()), async (from) => {
            fc.pre(!from.startsWith('https://'));
            const result = await PasskeyService.allowedEntries(db(), { challenge, rpId: undefined }, from);
            expect('errorCode' in result).toBe(true);
        }), settings());
    });
});

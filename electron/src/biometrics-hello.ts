import { app, safeStorage } from 'electron';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    makeChallenge,
    deriveKeyWithEntropy,
    isV4Blob,
    sealPasswordV4,
    challengeFromV4Blob,
    openPasswordV4,
    deriveSessionKey,
    sealPasswordSession,
    challengeFromSessionBlob,
    openPasswordSession
} from './biometrics-crypto';
import { ArmError, ReleaseError, type QuickUnlockProvider } from './biometrics-provider';
import { Passport } from './get-passport';

// v4 blobs mix a DPAPI-protected random value into the key derivation as the
// HKDF salt. See biometrics-crypto.ts for what that does and does not defend
const ENTROPY_PATH = () => path.join(app.getPath('userData'), 'biometric-entropy.bin');

function loadEntropy(): Buffer | null {
    try {
        const wrapped = fs.readFileSync(ENTROPY_PATH());
        const entropy = Buffer.from(safeStorage.decryptString(wrapped), 'hex');
        return entropy.length === 32 ? entropy : null;
    } catch {
        return null;
    }
}

function loadOrCreateEntropy(): Buffer | null {
    const existing = loadEntropy();
    if (existing) return existing;
    try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        const entropy = randomBytes(32);
        fs.writeFileSync(ENTROPY_PATH(), safeStorage.encryptString(entropy.toString('hex')), { mode: 0o600 });
        return entropy;
    } catch (error) {
        console.error('Failed to store biometric entropy:', error);
        return null;
    }
}

// Windows: a Hello signature over a challenge. Signing requires a live Hello
// verification and the RSA PKCS#1 v1.5 signature is deterministic, so the
// same challenge always re-derives the same signature, but only after the
// user passes Hello. Replaces the old hardware-id derivation (which also
// depended on wmic, removed in Windows 11 24H2)
async function getWindowsHelloSignature(dbPath: string, challenge: Buffer): Promise<Buffer> {
    const passport = new Passport(dbPath);
    if (!passport.accountExists) {
        await passport.createAccount();
    }
    return await passport.sign(challenge);
}

export const windowsHello: QuickUnlockProvider = {
    id: 'windows-hello',
    method: 'Windows Hello',
    needsPin: false,
    sessionMarker: 'v4-session:',

    supported: () => Passport.available(),
    biometryType: () => 'windows-hello',
    refusal: async () => null,

    // The signature is the Hello prompt, on first enable and on every re-arm
    // after a restart alike: a copy sealed without it would be one anything
    // in this process's memory could open
    async arm(target) {
        const challenge = makeChallenge();
        try {
            return { secret: await getWindowsHelloSignature(target.dbPath, challenge), binding: challenge };
        } catch (error) {
            console.error('Windows Hello signing failed while arming:', error);
            throw new ArmError('Windows Hello verification failed');
        }
    },

    async release(target, binding) {
        try {
            return await getWindowsHelloSignature(target.dbPath, binding);
        } catch (error) {
            throw new ReleaseError('failed', error);
        }
    },

    async retire() {},

    // Best effort: also drop the Hello signing key so nothing lingers
    async remove(target) {
        try {
            const passport = new Passport(target.dbPath);
            if (passport.accountExists) await passport.deleteAccount();
        } catch { /* account already gone */ }
    },

    persistent: {
        isBlob: isV4Blob,
        binding: challengeFromV4Blob,
        sealer() {
            const entropy = loadOrCreateEntropy();
            if (!entropy) return null;
            return (password, material) =>
                sealPasswordV4(password, material.binding, deriveKeyWithEntropy(material.secret, entropy));
        },
        // Without the DPAPI-wrapped half of the key material (new OS user
        // profile, deleted file) no blob can open
        opener() {
            const entropy = loadEntropy();
            if (!entropy) return null;
            return (stored, secret) => openPasswordV4(stored, deriveKeyWithEntropy(secret, entropy));
        },
        // The DPAPI entropy is half the key for every v4 blob at once, so
        // dropping it also covers a blob the retirement sweep missed (a keytar
        // without findCredentials), which without the entropy reads as stale
        // and is discarded
        retireAll() {
            try {
                fs.rmSync(ENTROPY_PATH(), { force: true });
            } catch (error) {
                console.error('Failed to remove the biometric entropy:', error);
            }
        }
    },

    session: {
        seal(password, material) {
            const salt = randomBytes(32);
            return { blob: sealPasswordSession(password, material.binding, deriveSessionKey(material.secret, salt)), salt };
        },
        binding: (sealed) => challengeFromSessionBlob(sealed.blob),
        open: (sealed, secret) => openPasswordSession(sealed.blob, deriveSessionKey(secret, sealed.salt))
    }
};

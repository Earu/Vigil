import { systemPreferences } from 'electron';
import { randomBytes } from 'crypto';
import {
    isV3Blob,
    sealWithKeychainKey,
    openWithKeychainKey,
    sealSessionWithKeychainKey,
    openSessionWithKeychainKey
} from './biometrics-crypto';
import { ArmError, ReleaseError, type QuickUnlockProvider } from './biometrics-provider';

// Biometry-gated keychain addon (macOS). Reports 'unavailable' on every call
// when the binary is missing, so the import is safe on every platform
import * as touchid from '../native/touchid';

// Account used only to find out whether this build may write entitlement
// gated keychain items; never holds anything meaningful
const ENTITLEMENT_PROBE_ACCOUNT = '__vigil_entitlement_probe__';

const NO_BINDING = Buffer.alloc(0);

// macOS with the native addon: the master password is sealed under a random
// key held in a biometry-gated keychain item, so the OS enforces the Touch ID
// check before the key material exists in this process. This is the macOS
// equivalent of the Windows Hello path, and unlike the legacy scheme below
// the ciphertext is not openable by anything that can read the disk.
export type MacBiometricBackend = 'secure' | 'gate';

let macBackendProbe: Promise<MacBiometricBackend> | null = null;

export function resetTouchIdForTests(): void {
    macBackendProbe = null;
}

// Whether the data protection keychain will accept a write from this build.
// It only does for a build signed with the application-identifier and
// keychain-access-groups entitlements a provisioning profile authorizes
// (Apple TN3137); unsigned and ad-hoc signed builds get
// errSecMissingEntitlement. The answer cannot change while the app runs, and
// the only way to ask is to try, so probe once with a throwaway item
async function probeMacBackend(): Promise<MacBiometricBackend> {
    if (!touchid.isLoaded() || !touchid.availability().usable) {
        console.info('Biometric backend: none (Touch ID addon unavailable)');
        return 'gate';
    }
    const written = await touchid.setSecret(ENTITLEMENT_PROBE_ACCOUNT, randomBytes(32));
    if (!written.ok) {
        console.info(`Biometric backend: none (keychain rejected the probe: ${written.code})`);
        return 'gate';
    }
    await touchid.deleteSecret(ENTITLEMENT_PROBE_ACCOUNT);
    console.info('Biometric backend: hardware (biometry-gated keychain)');
    return 'secure';
}

function getMacBackend(): Promise<MacBiometricBackend> {
    if (!macBackendProbe) {
        macBackendProbe = probeMacBackend().catch((error) => {
            console.error('Touch ID keychain probe failed:', error);
            return 'gate' as const;
        });
    }
    return macBackendProbe;
}

// Why a Mac with a working sensor still gets no biometric unlock: the
// biometry-gated keychain only accepts writes from a build signed with the
// entitlements a provisioning profile authorizes. Shown to the user, since
// from where they sit the sensor works and the option is simply missing
const MAC_UNSIGNED_BUILD = 'Biometric unlock needs a signed build of Vigil: this build cannot keep the key in the biometry-gated keychain';

// Store a fresh wrapping key, then read it straight back. The read is what
// asks the user for Touch ID, so enabling is confirmed by the same check that
// will later unlock, and a keychain item the OS accepted but cannot actually
// release is caught here instead of at unlock time.
//
// `confirm` is false only for a silent re-arm of an already enrolled vault
// after a restart. The user has just proved themselves with the master
// password, the wrapping key is generated here rather than released by the
// keychain, and the item was confirmed readable when they enrolled, so a
// prompt there would decide nothing and only add one more Touch ID dialog to
// be habituated to
async function enableSecureMac(account: string, dbName: string, confirm: boolean):
    Promise<{ wrappingKey: Buffer } | { error: string } | null> {
    const wrappingKey = randomBytes(32);
    const written = await touchid.setSecret(account, wrappingKey);
    if (!written.ok) {
        console.error('Touch ID keychain write failed:', written.code, written.status ?? '');
        return null;
    }
    if (!confirm) return { wrappingKey };

    const readBack = await touchid.getSecret(account, `confirm biometric unlock for ${dbName}`);
    if (!readBack.ok) {
        await touchid.deleteSecret(account);
        if (readBack.code === 'canceled') {
            console.warn('Touch ID confirmation was cancelled while enabling; nothing stored');
            return { error: 'Biometric authentication was cancelled' };
        }
        // Anything else means the round trip is not trustworthy on this
        // machine. The caller refuses to enable: storing a blob only a broken
        // keychain item can open helps nobody, and no weaker scheme is offered
        console.error('Touch ID keychain read-back failed:', readBack.code, readBack.status ?? '');
        return null;
    }
    if (!readBack.data.equals(wrappingKey)) {
        await touchid.deleteSecret(account);
        console.error('Touch ID keychain returned a different key than it stored');
        return null;
    }

    return { wrappingKey };
}

// The keychain is the only place the password may be sealed to. A
// build the keychain refuses gets no unlock rather than a weaker one:
// the old fallback stored the password under a key the whole user
// account could derive, behind a prompt that decided nothing
export async function keychainRefusal(): Promise<string | null> {
    return await getMacBackend() === 'secure' ? null : MAC_UNSIGNED_BUILD;
}

export const touchId: QuickUnlockProvider = {
    id: 'touch-id',
    method: 'Touch ID',
    needsPin: false,
    sessionMarker: 'v3-session:',

    supported: () => systemPreferences.canPromptTouchID(),
    biometryType: () => touchid.availability().biometryType,
    refusal: keychainRefusal,

    async arm(target, confirm) {
        const sealed = await enableSecureMac(target.account, target.dbName, confirm);
        // The keychain took the key and would not give it back. That is a
        // hard failure: enabling anyway would either store a blob only a
        // broken keychain item can open, or fall back to the scheme above
        if (!sealed) throw new ArmError('Could not set up biometric unlock: the keychain did not release the key it stored');
        if ('error' in sealed) throw new ArmError(sealed.error);
        return { secret: sealed.wrappingKey, binding: NO_BINDING };
    },

    // The keychain read is the Touch ID prompt
    async release(target) {
        const released = await touchid.getSecret(target.account, `unlock ${target.dbName} with biometrics`);
        if (released.ok) return released.data;
        // 'not-found' is what macOS does when the enrolled fingerprints change
        // (BiometryCurrentSet): the item is gone, so nothing sealed under it
        // can ever open again
        if (released.code === 'not-found') throw new ReleaseError('gone', released.code);
        if (released.code === 'canceled') throw new ReleaseError('canceled', released.code);
        // missing-entitlement or unavailable means this build cannot reach
        // the item an earlier build wrote. A properly signed build will open
        // it again, so this is a failed attempt, not a lost key
        throw new ReleaseError('failed', `${released.code} ${released.status ?? ''}`.trim());
    },

    // The wrapping key is per account, so it goes with the blob it sealed and
    // a copy that outlived the keytar record cannot be opened either
    async retire(account) {
        await touchid.deleteSecret(account);
    },

    // Best effort: drop the keychain item too so no biometry-gated key
    // outlives the database it unlocked
    async remove(target) {
        await touchid.deleteSecret(target.account);
    },

    persistent: {
        isBlob: isV3Blob,
        binding: () => NO_BINDING,
        sealer: () => (password, material) => sealWithKeychainKey(password, material.secret),
        opener: () => openWithKeychainKey
    },

    session: {
        seal: (password, material) => ({ blob: sealSessionWithKeychainKey(password, material.secret), salt: NO_BINDING }),
        binding: () => NO_BINDING,
        open: (sealed, secret) => openSessionWithKeychainKey(sealed.blob, secret)
    }
};

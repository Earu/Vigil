import { systemPreferences, safeStorage } from 'electron';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import keytar from './get-keytar';
import {
    isV3Blob,
    isV4Blob,
    makeChallenge,
    deriveKeyWithEntropy,
    sealPasswordV4,
    challengeFromV4Blob,
    openPasswordV4,
    sealWithKeychainKey,
    openWithKeychainKey
} from './biometrics-crypto';

// Biometry-gated keychain addon (macOS). Reports 'unavailable' on every call
// when the binary is missing, so the import is safe on every platform
import * as touchid from '../native/touchid';

import { Passport, VerificationResult as PassportVerification } from './get-passport';

const SERVICE_NAME = 'Vigil Password Manager';
const SALT_PATH = path.join(app.getPath('userData'), '.salt');
// Account used only to find out whether this build may write entitlement
// gated keychain items; never holds anything meaningful
const ENTITLEMENT_PROBE_ACCOUNT = '__vigil_entitlement_probe__';

let biometricsAvailableCache: boolean | null = null;

// Tests exercise both macOS backends in one process
export function resetForTests(): void {
    biometricsAvailableCache = null;
    macBackendProbe = null;
    biometricsConfigCache = null;
    sessionPasswords.clear();
}

// ---- Windows: persistent-blob entropy and the session-scoped mode ----

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

// The session-scoped mode ("require master password after restart"): the
// keytar record is only the marker below, saying biometric unlock is wanted;
// the password itself lives in this process's memory and dies with it, so
// nothing on disk can release it and a phished Hello prompt from another
// process yields nothing. This is KeePassXC's quick-unlock model. The
// per-vault entries hold the dbPath too, so turning the setting off can
// re-seal each armed vault persistently without a restart
const SESSION_MARKER = 'v4-session:';
const sessionPasswords = new Map<string, { dbPath: string; password: string }>();

interface BiometricsConfig { requirePasswordAfterRestart: boolean }
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'biometrics-config.json');
let biometricsConfigCache: BiometricsConfig | null = null;

export function getBiometricsConfig(): BiometricsConfig {
    if (biometricsConfigCache) return biometricsConfigCache;
    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
        biometricsConfigCache = { requirePasswordAfterRestart: parsed.requirePasswordAfterRestart === true };
    } catch {
        biometricsConfigCache = { requirePasswordAfterRestart: false };
    }
    return biometricsConfigCache;
}

export async function setBiometricsConfig(config: BiometricsConfig): Promise<{ success: boolean; error?: string }> {
    try {
        fs.writeFileSync(CONFIG_PATH(), JSON.stringify({ requirePasswordAfterRestart: config.requirePasswordAfterRestart === true }), { mode: 0o600 });
        biometricsConfigCache = { requirePasswordAfterRestart: config.requirePasswordAfterRestart === true };
    } catch (error) {
        console.error('Failed to store the biometrics config:', error);
        return { success: false, error: 'Failed to store the setting' };
    }

    // Turning the requirement off while session entries are armed: the
    // passwords are in hand, so re-seal each one persistently now (one Hello
    // prompt per vault, which is the consent to store it) instead of asking
    // for the master password again after the next restart. A vault whose
    // prompt is refused simply stays session-scoped
    if (!config.requirePasswordAfterRestart && process.platform === 'win32') {
        for (const [key, entry] of [...sessionPasswords]) {
            try {
                const entropy = loadOrCreateEntropy();
                if (!entropy) break;
                const challenge = makeChallenge();
                const signature = await getWindowsHelloSignature(entry.dbPath, challenge);
                const helloKey = deriveKeyWithEntropy(signature, entropy);
                await keytar?.setPassword(SERVICE_NAME, key, sealPasswordV4(entry.password, challenge, helloKey));
                sessionPasswords.delete(key);
            } catch (error) {
                console.error('Keeping a vault session-scoped, the re-seal was refused:', error);
            }
        }
    }
    return { success: true };
}

function generateNewSalt(): string {
    const buffer = Buffer.alloc(32);
    require('crypto').randomFillSync(buffer);
    return buffer.toString('hex');
}

// Read first, create exclusively only when the read says there is nothing:
// no check-then-act window in which a second call (two vaults unlocking at
// once) could each write a different salt and key every later lookup wrong
async function getInstallationSalt(): Promise<string> {
    try {
        try {
            return await fs.promises.readFile(SALT_PATH, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        const newSalt = generateNewSalt();
        try {
            await fs.promises.writeFile(SALT_PATH, newSalt, { mode: 0o600, flag: 'wx' });
            return newSalt;
        } catch (error) {
            // Lost the race to another caller; theirs is the salt now
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            return await fs.promises.readFile(SALT_PATH, 'utf-8');
        }
    } catch (error) {
        console.error('Failed to manage installation salt:', error);
        return generateNewSalt();
    }
}

async function generateUniqueKey(dbPath: string): Promise<string> {
    const salt = await getInstallationSalt();
    return `${dbPath}_${salt}`;
}

export async function isBiometricsAvailable(): Promise<boolean> {
    if (!keytar) {
        console.warn('Keytar is not available');
        return false;
    }

    if (biometricsAvailableCache !== null) {
        return biometricsAvailableCache;
    }

    try {
        if (process.platform === 'darwin') {
            biometricsAvailableCache = systemPreferences.canPromptTouchID();
        } else if (process.platform === 'win32') {
            biometricsAvailableCache = Passport.available();
        } else {
            biometricsAvailableCache = false;
        }
    } catch (error) {
        console.error('Error checking biometrics availability:', error);
        biometricsAvailableCache = false;
    }

    return biometricsAvailableCache || false;
}

// macOS with the native addon: the master password is sealed under a random
// key held in a biometry-gated keychain item, so the OS enforces the Touch ID
// check before the key material exists in this process. This is the macOS
// equivalent of the Windows Hello path, and unlike the legacy scheme below
// the ciphertext is not openable by anything that can read the disk.
export type MacBiometricBackend = 'secure' | 'gate';

let macBackendProbe: Promise<MacBiometricBackend> | null = null;

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

// Store the wrapping key, then read it straight back. The read is what asks
// the user for Touch ID, so enabling is confirmed by the same check that will
// later unlock, and a keychain item the OS accepted but cannot actually
// release is caught here instead of at unlock time
async function enableSecureMac(account: string, dbName: string):
    Promise<{ wrappingKey: Buffer } | { error: string } | null> {
    const wrappingKey = randomBytes(32);
    const written = await touchid.setSecret(account, wrappingKey);
    if (!written.ok) {
        console.error('Touch ID keychain write failed:', written.code, written.status ?? '');
        return null;
    }

    const readBack = await touchid.getSecret(account, `confirm biometric unlock for ${dbName}`);
    if (!readBack.ok) {
        await touchid.deleteSecret(account);
        if (readBack.code === 'canceled') {
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

// The Hello check for releasing a session-scoped password: an access-control
// decision rather than key derivation, since the password never leaves this
// process's memory either way
async function verifyWindowsHello(message: string): Promise<boolean> {
    const result = await Passport.requestVerification(message);
    return result === PassportVerification.Verified;
}

const REARM_MESSAGE = 'Enter the master password once after a restart to re-arm Windows Hello unlock';

function windowsDbName(dbPath: string): string {
    return dbPath.split(/[\\/]/).pop() || dbPath;
}

// A blob in any outdated format is a convenience secret the current code
// no longer reads: it is discarded and the user re-enables, per the policy
// in biometrics-crypto.ts
const OUTDATED_BLOB = 'Biometric unlock was upgraded, please enable it again in settings';

async function discardOutdatedBlob(key: string): Promise<void> {
    console.warn('Discarding a biometric blob in an outdated format');
    await keytar?.deletePassword(SERVICE_NAME, key);
}

// Why a Mac with a working sensor still gets no biometric unlock: the
// biometry-gated keychain only accepts writes from a build signed with the
// entitlements a provisioning profile authorizes. Shown to the user, since
// from where they sit the sensor works and the option is simply missing
const MAC_UNSIGNED_BUILD = 'Biometric unlock needs a signed build of Vigil: this build cannot keep the key in the biometry-gated keychain';

// `armed` says whether an unlock attempt could release a password right
// now: false for a session-scoped vault after a restart (and for a
// persistent blob frozen by the require-password-after-restart setting),
// where the next password unlock re-arms it
export async function hasBiometricsEnabled(dbPath: string): Promise<{ success: boolean, error?: string, enabled?: boolean, armed?: boolean }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, key);
        if (!stored) return { success: true, enabled: false };

        if (process.platform === 'darwin') {
            if (isV3Blob(stored)) return { success: true, enabled: true, armed: true };
            await discardOutdatedBlob(key);
            return { success: true, enabled: false };
        }
        if (process.platform === 'win32') {
            const strict = getBiometricsConfig().requirePasswordAfterRestart;
            if (stored === SESSION_MARKER) {
                return { success: true, enabled: true, armed: sessionPasswords.has(key) };
            }
            if (isV4Blob(stored)) {
                return { success: true, enabled: true, armed: !strict };
            }
            await discardOutdatedBlob(key);
            return { success: true, enabled: false };
        }
        return { success: true, enabled: true, armed: true };
    } catch (error) {
        console.error('Failed to check biometrics status:', error);
        return { success: false, error: 'Failed to check biometrics status' };
    }
}

export async function enableBiometrics(dbPath: string, password: string): Promise<{ success: boolean, error?: string }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);

        if (process.platform === 'win32') {
            if (getBiometricsConfig().requirePasswordAfterRestart) {
                // Session-scoped: the password stays in this process's memory
                // and keytar holds only the intent marker. The first enable
                // proves the user can pass Hello; a re-arm after a restart
                // just proved it better, by typing the master password
                const existing = await keytar?.getPassword(SERVICE_NAME, key);
                if (existing !== SESSION_MARKER) {
                    if (!await verifyWindowsHello(`Enable Windows Hello unlock for ${windowsDbName(dbPath)}`)) {
                        return { success: false, error: 'Windows Hello verification failed' };
                    }
                }
                sessionPasswords.set(key, { dbPath, password });
                await keytar?.setPassword(SERVICE_NAME, key, SESSION_MARKER);
                return { success: true };
            }

            // Persistent: the sign call is the Hello verification; a
            // cancelled prompt throws and nothing is stored
            const entropy = loadOrCreateEntropy();
            if (!entropy) {
                return { success: false, error: 'Could not set up biometric unlock: the entropy store is unavailable' };
            }
            const challenge = makeChallenge();
            const signature = await getWindowsHelloSignature(dbPath, challenge);
            const helloKey = deriveKeyWithEntropy(signature, entropy);
            sessionPasswords.delete(key);
            await keytar?.setPassword(SERVICE_NAME, key, sealPasswordV4(password, challenge, helloKey));
            return { success: true };
        }

        if (process.platform !== 'darwin') {
            return { success: false, error: 'Biometric authentication is not available on this platform' };
        }

        // The keychain is the only place the password may be sealed to. A
        // build the keychain refuses gets no unlock rather than a weaker one:
        // the old fallback stored the password under a key the whole user
        // account could derive, behind a prompt that decided nothing
        if (await getMacBackend() !== 'secure') {
            return { success: false, error: MAC_UNSIGNED_BUILD };
        }

        const dbName = dbPath.split('/').pop() as string;
        const sealed = await enableSecureMac(key, dbName);
        if (!sealed) {
            // The keychain took the key and would not give it back. That is a
            // hard failure: enabling anyway would either store a blob only a
            // broken keychain item can open, or fall back to the scheme above
            return { success: false, error: 'Could not set up biometric unlock: the keychain did not release the key it stored' };
        }
        if ('error' in sealed) return { success: false, error: sealed.error };

        await keytar?.setPassword(SERVICE_NAME, key, sealWithKeychainKey(password, sealed.wrappingKey));
        return { success: true };
    } catch (error) {
        console.error('Failed to enable biometrics:', error);
        return { success: false, error: 'Failed to enable biometric authentication' };
    }
}

// `retry` says the stored credential is still good and only this attempt
// failed (cancelled prompt, unrecognised finger). Without it the caller cannot
// tell that apart from credentials that can never be opened again, and tearing
// the user's biometric setup down every time they dismiss a prompt is wrong
export async function getBiometricPassword(dbPath: string):
    Promise<{ success: boolean, error?: string, password?: string, retry?: boolean }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: 'Biometric authentication is not available on this device' };
        }

        const key = await generateUniqueKey(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, key);
        if (!stored) {
            return { success: false, error: 'No password found for this database' };
        }

        if (process.platform === 'win32') {
            const strict = getBiometricsConfig().requirePasswordAfterRestart;

            if (stored === SESSION_MARKER) {
                const entry = sessionPasswords.get(key);
                if (!entry) {
                    // Post-restart: nothing on disk can release the password,
                    // by design. The password unlock re-arms this session
                    return { success: false, retry: true, error: REARM_MESSAGE };
                }
                if (!await verifyWindowsHello(`Unlock ${windowsDbName(dbPath)} in Vigil`)) {
                    return { success: false, retry: true, error: 'Biometric authentication failed' };
                }
                return { success: true, password: entry.password };
            }

            if (strict && isV4Blob(stored)) {
                // The setting says nothing on disk may release the password,
                // so a persistent blob written before the switch stays
                // sealed; the next password unlock converts it to session
                // scope (the re-arm path overwrites it with the marker)
                return { success: false, retry: true, error: REARM_MESSAGE };
            }

            if (isV4Blob(stored)) {
                const entropy = loadEntropy();
                if (!entropy) {
                    // The DPAPI-wrapped half of the key material is gone (new
                    // OS user profile, deleted file); the blob cannot open
                    await keytar?.deletePassword(SERVICE_NAME, key);
                    return { success: false, error: 'Biometric data is stale, please enable biometric unlock again' };
                }
                let signature: Buffer;
                try {
                    signature = await getWindowsHelloSignature(dbPath, challengeFromV4Blob(stored));
                } catch (error) {
                    // Cancelled or failed Hello prompt; the stored blob stays
                    console.error('Windows Hello authentication failed:', error);
                    return { success: false, error: 'Biometric authentication failed', retry: true };
                }
                try {
                    return { success: true, password: openPasswordV4(stored, deriveKeyWithEntropy(signature, entropy)) };
                } catch {
                    // Decryption failure means the Hello key changed (e.g.
                    // Hello was reset); the blob is unrecoverable
                    await keytar?.deletePassword(SERVICE_NAME, key);
                    return { success: false, error: 'Biometric data is stale, please enable biometric unlock again' };
                }
            }

            // v2 (Hello signature without the entropy salt) or the ancient
            // hardware-id scheme: outdated either way, discard and re-enable
            await discardOutdatedBlob(key);
            return { success: false, error: OUTDATED_BLOB };
        }

        const dbName = dbPath.split('/').pop() as string;

        if (process.platform === 'darwin' && isV3Blob(stored)) {
            // Sealed against the keychain item, so only the item can open it.
            // The read is the Touch ID prompt
            const wrappingKey = await touchid.getSecret(key, `unlock ${dbName} with biometrics`);
            if (!wrappingKey.ok) {
                if (wrappingKey.code === 'not-found') {
                    // The item is gone, which is what macOS does when the
                    // enrolled fingerprints change (BiometryCurrentSet). The
                    // blob can never be opened again
                    await keytar?.deletePassword(SERVICE_NAME, key);
                    return { success: false, error: 'Biometric enrollment changed, please enable biometric unlock again' };
                }
                if (wrappingKey.code === 'canceled') {
                    return { success: false, error: 'Biometric authentication was cancelled', retry: true };
                }
                // missing-entitlement or unavailable means this build cannot
                // reach the item an earlier build wrote. Keep the blob: a
                // properly signed build will open it again
                console.error('Touch ID keychain read failed:', wrappingKey.code, wrappingKey.status ?? '');
                return { success: false, error: 'Biometric authentication failed', retry: true };
            }
            try {
                return { success: true, password: openWithKeychainKey(stored, wrappingKey.data) };
            } catch {
                await keytar?.deletePassword(SERVICE_NAME, key);
                return { success: false, error: 'Biometric data is stale, please enable biometric unlock again' };
            }
        }

        if (process.platform !== 'darwin') {
            return { success: false, error: 'Biometric authentication is not available on this platform' };
        }

        await discardOutdatedBlob(key);
        return { success: false, error: OUTDATED_BLOB };
    } catch (error) {
        console.error('Failed to get password with biometrics:', error);
        return { success: false, error: 'Failed to authenticate with biometrics', retry: true };
    }
}

export async function disableBiometrics(dbPath: string): Promise<{ success: boolean, error?: string }> {
    try {
        const key = await generateUniqueKey(dbPath);
        sessionPasswords.delete(key);
        await keytar?.deletePassword(SERVICE_NAME, key);
        if (process.platform === 'darwin') {
            // Best effort: drop the keychain item too so no biometry-gated
            // key outlives the database it unlocked
            await touchid.deleteSecret(key);
        }
        if (process.platform === 'win32') {
            // Best effort: also drop the Hello signing key so nothing lingers
            try {
                const passport = new Passport(dbPath);
                if (passport.accountExists) await passport.deleteAccount();
            } catch { /* account already gone */ }
        }
        return { success: true };
    } catch (error) {
        console.error('Failed to disable biometrics:', error);
        return { success: false, error: 'Failed to disable biometric authentication' };
    }
}

// 'hardware' is the only backend a password is ever stored under: the OS
// releases the key after a biometric check it enforces itself. A platform
// without that has no biometric unlock, and says why
export type BiometricsBackend = 'hardware' | 'none';

export async function getBiometricsInfo(): Promise<{
    available: boolean,
    backend: BiometricsBackend,
    biometryType: string,
    unavailableReason?: string
}> {
    const available = await isBiometricsAvailable();
    if (!available) return { available: false, backend: 'none', biometryType: 'none' };

    if (process.platform === 'win32') {
        return { available: true, backend: 'hardware', biometryType: 'windows-hello' };
    }

    if (process.platform === 'darwin') {
        const biometryType = touchid.availability().biometryType;
        if (await getMacBackend() !== 'secure') {
            return { available: false, backend: 'none', biometryType, unavailableReason: MAC_UNSIGNED_BUILD };
        }
        return { available: true, backend: 'hardware', biometryType };
    }

    return { available: false, backend: 'none', biometryType: 'none' };
}

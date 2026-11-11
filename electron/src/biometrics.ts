import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import keytar from './get-keytar';
import {
    ArmError,
    ReleaseError,
    type KeyMaterial,
    type QuickUnlockMethod,
    type QuickUnlockProvider,
    type SessionSeal,
    type UnlockTarget
} from './biometrics-provider';
import { windowsHello } from './biometrics-hello';
import { touchId, resetTouchIdForTests } from './biometrics-touchid';
import { macPin } from './biometrics-pin-mac';
import { tpmPin, resetTpmForTests } from './biometrics-pin-tpm';

export {
    getPinLockoutPolicy,
    setAllowUnprotectedTpm,
    getTpmSetupStep,
    grantTpmAccess,
    tpmAccessGranted,
    revokeTpmAccess,
    getTpmLockoutPlan,
    beginTpmLockout,
    cancelTpmLockout,
    applyTpmLockout,
    type PinLockoutPolicy
} from './biometrics-pin-tpm';

const SERVICE_NAME = 'Vigil Password Manager';
const SALT_PATH = path.join(app.getPath('userData'), '.salt');

function platformProviders(): QuickUnlockProvider[] {
    if (process.platform === 'win32') return [windowsHello, tpmPin];
    if (process.platform === 'darwin') return [touchId, macPin];
    if (process.platform === 'linux') return [tpmPin];
    return [];
}

let supportedCache: QuickUnlockProvider[] | null = null;

function supportedProviders(): QuickUnlockProvider[] {
    if (supportedCache) return supportedCache;
    supportedCache = platformProviders().filter(provider => {
        try {
            return provider.supported();
        } catch (error) {
            console.error(`Error checking ${provider.method} availability:`, error);
            return false;
        }
    });
    return supportedCache;
}

function providerForRecord(stored: string): QuickUnlockProvider | null {
    return platformProviders().find(provider =>
        stored === provider.sessionMarker || provider.persistent.isBlob(stored)) ?? null;
}

// What the session mode retains in memory, for the test that checks the
// password is not among it
export function sessionStateForTests(): unknown {
    return [...sessionPasswords.entries()];
}

// Tests exercise both macOS backends in one process
export function resetForTests(): void {
    supportedCache = null;
    resetTouchIdForTests();
    resetTpmForTests();
    biometricsConfigCache = null;
    persistentBlobsRetired = null;
    sessionPasswords.clear();
}

// The session-scoped mode ("require master password after restart"), the
// default on both platforms that have biometric unlock: the keytar record is
// only the provider's marker, saying biometric unlock is wanted. The password
// lives in this process's memory, sealed under a key nothing on disk can
// produce, so a phished prompt from another process yields nothing and a
// restart takes the sealed copy away. This is KeePassXC's quick-unlock model.
//
// Windows seals under a Hello signature over a per-arming challenge; macOS
// seals under a wrapping key that lives in the biometry-gated keychain and is
// regenerated at every arming (see biometrics-crypto.ts for what each one
// costs an attacker). Each platform keeps its own marker, so a record is
// never read under the other's rules. Each entry carries what re-sealing it
// persistently would need (the dbPath Hello signs against, the dbName the
// Touch ID prompt names), so turning the setting off converts every armed
// vault without waiting for a restart
interface SessionEntry {
    providerId: QuickUnlockMethod;
    target: UnlockTarget;
    sealed: SessionSeal;
}

const sessionPasswords = new Map<string, SessionEntry>();

interface BiometricsConfig { requirePasswordAfterRestart: boolean }
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'biometrics-config.json');
let biometricsConfigCache: BiometricsConfig | null = null;

// Session scope is the default, as it is KeePassXC's only mode: a persistent
// blob is openable by same-user code with one habituated Hello prompt (see
// biometrics-crypto.ts), and nothing the user did asked for that trade. An
// explicit false in the file is the user's choice and is kept
export function getBiometricsConfig(): BiometricsConfig {
    if (biometricsConfigCache) return biometricsConfigCache;
    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
        biometricsConfigCache = { requirePasswordAfterRestart: parsed.requirePasswordAfterRestart !== false };
    } catch {
        biometricsConfigCache = { requirePasswordAfterRestart: true };
    }
    return biometricsConfigCache;
}

// The setting says nothing on disk may release a password, and a persistent
// blob written before it took effect is exactly that. Each one becomes the
// session marker, so the vault stays enrolled and the next password unlock
// re-arms it, and the key material it was sealed under is destroyed with it,
// so a copy that outlived the keytar record (a keychain backup, credential
// roaming) cannot be opened either. Runs once per process the first time the
// setting is consulted, and again whenever it is switched on, so blobs from
// before the default changed are retired without the user touching anything
let persistentBlobsRetired: Promise<void> | null = null;

async function retireBlob(provider: QuickUnlockProvider, account: string): Promise<void> {
    try {
        await keytar?.setPassword(SERVICE_NAME, account, provider.sessionMarker);
        await provider.retire(account);
    } catch (error) {
        console.error('Failed to retire a persistent biometric blob:', error);
    }
}

async function retirePersistentBlobs(): Promise<void> {
    if (!keytar) return;
    try {
        if (typeof keytar.findCredentials === 'function') {
            for (const { account, password } of await keytar.findCredentials(SERVICE_NAME)) {
                const provider = providerForRecord(password);
                if (provider?.persistent.isBlob(password)) await retireBlob(provider, account);
            }
        }
    } catch (error) {
        console.error('Failed to retire persistent biometric blobs:', error);
    }
    for (const provider of platformProviders()) provider.persistent.retireAll?.();
}

function ensurePersistentBlobsRetired(): Promise<void> {
    if (!persistentBlobsRetired) persistentBlobsRetired = retirePersistentBlobs();
    return persistentBlobsRetired;
}

// Retiring a blob at the moment it is read. The sweep runs once per process
// and only covers what findCredentials reports, so the blob in hand is
// retired here as well. Both steps are idempotent
async function retireBlobOnSight(provider: QuickUnlockProvider, account: string): Promise<void> {
    await ensurePersistentBlobsRetired();
    await retireBlob(provider, account);
}

export async function setBiometricsConfig(config: BiometricsConfig): Promise<{ success: boolean; error?: string }> {
    try {
        fs.writeFileSync(CONFIG_PATH(), JSON.stringify({ requirePasswordAfterRestart: config.requirePasswordAfterRestart === true }), { mode: 0o600 });
        biometricsConfigCache = { requirePasswordAfterRestart: config.requirePasswordAfterRestart === true };
    } catch (error) {
        console.error('Failed to store the biometrics config:', error);
        return { success: false, error: 'Failed to store the setting' };
    }

    if (platformProviders().length === 0) return { success: true };

    if (config.requirePasswordAfterRestart) {
        persistentBlobsRetired = retirePersistentBlobs();
        await persistentBlobsRetired;
        return { success: true };
    }

    // Turning the requirement off while session entries are armed: re-seal
    // each one persistently now (one biometric prompt per vault, which both
    // opens the session copy and is the consent to store it) instead of asking
    // for the master password again after the next restart. A vault whose
    // prompt is refused simply stays session-scoped
    for (const [key, entry] of [...sessionPasswords]) {
        const provider = platformProviders().find(candidate => candidate.id === entry.providerId);
        if (!provider || provider.needsPin) continue;
        try {
            const seal = provider.persistent.sealer();
            if (!seal) continue;
            const binding = provider.session.binding(entry.sealed);
            const secret = await provider.release(entry.target, binding);
            const password = provider.session.open(entry.sealed, secret);
            await keytar?.setPassword(SERVICE_NAME, key, seal(password, { secret, binding }));
            sessionPasswords.delete(key);
        } catch (error) {
            console.error('Keeping a vault session-scoped, the re-seal was refused:', error);
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

async function targetFor(dbPath: string): Promise<UnlockTarget> {
    const salt = await getInstallationSalt();
    return { account: `${dbPath}_${salt}`, dbPath, dbName: dbPath.split('/').pop() as string };
}

export async function isBiometricsAvailable(): Promise<boolean> {
    if (!keytar) {
        console.warn('Keytar is not available');
        return false;
    }
    return supportedProviders().length > 0;
}

// Shown when the biometric unlock is enrolled but this run of the app has no
// sealed copy to release. It says what to do and what happens next, in the
// user's terms: "re-arm" and "session" are this file's words, not theirs, and
// "restart" is ambiguous between the machine and the app
function masterPasswordNeededMessage(provider: QuickUnlockProvider): string {
    return `Unlock with your master password once, then ${provider.method} works again until you quit Vigil`;
}

// A blob in any outdated format is a convenience secret the current code
// no longer reads: it is discarded and the user re-enables, per the policy
// in biometrics-crypto.ts
const OUTDATED_BLOB = 'Biometric unlock was upgraded, please enable it again in settings';
const STALE_BLOB = 'Biometric data is stale, please enable biometric unlock again';
const UNAVAILABLE = 'Biometric authentication is not available on this device';

async function discardOutdatedBlob(account: string): Promise<void> {
    console.warn('Discarding a biometric blob in an outdated format');
    await keytar?.deletePassword(SERVICE_NAME, account);
}

// `armed` says whether an unlock attempt could release a password right
// now: false for a session-scoped vault after a restart (and for a
// persistent blob frozen by the require-password-after-restart setting),
// where the next password unlock re-arms it
export async function hasBiometricsEnabled(dbPath: string):
    Promise<{ success: boolean, error?: string, enabled?: boolean, armed?: boolean, method?: QuickUnlockMethod }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: UNAVAILABLE };
        }

        const { account } = await targetFor(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, account);
        if (!stored) return { success: true, enabled: false };

        const provider = providerForRecord(stored);
        if (!provider) {
            await discardOutdatedBlob(account);
            return { success: true, enabled: false };
        }
        const method = provider.id;

        if (getBiometricsConfig().requirePasswordAfterRestart && provider.persistent.isBlob(stored)) {
            // A persistent blob under the setting: retire it (and every
            // other one) now rather than report it frozen
            await retireBlobOnSight(provider, account);
            return { success: true, enabled: true, armed: false, method };
        }
        if (stored === provider.sessionMarker) {
            return { success: true, enabled: true, armed: sessionPasswords.get(account)?.providerId === method, method };
        }
        return { success: true, enabled: true, armed: true, method };
    } catch (error) {
        console.error('Failed to check biometrics status:', error);
        return { success: false, error: 'Failed to check biometrics status' };
    }
}

export interface EnableOptions {
    method?: QuickUnlockMethod;
    pin?: string;
}

export async function enableBiometrics(dbPath: string, password: string, options: EnableOptions = {}):
    Promise<{ success: boolean, error?: string }> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: UNAVAILABLE };
        }

        const target = await targetFor(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, target.account);
        const current = stored ? providerForRecord(stored) : null;
        const provider = options.method
            ? supportedProviders().find(candidate => candidate.id === options.method)
            : current ?? supportedProviders()[0];
        if (!provider) {
            return { success: false, error: 'This unlock method is not available on this device' };
        }

        const refusal = await provider.refusal();
        if (refusal) {
            console.error(`Refusing to enable biometric unlock: ${refusal}`);
            return { success: false, error: refusal };
        }

        const strict = getBiometricsConfig().requirePasswordAfterRestart;
        const persist = !strict && !(provider.needsPin && options.pin === undefined);
        const seal = persist ? provider.persistent.sealer() : null;
        if (persist && !seal) {
            return { success: false, error: 'Could not set up biometric unlock: the entropy store is unavailable' };
        }

        // A vault already carrying the marker is being re-armed after a
        // restart, not enrolled, so it does not need the confirmation prompt
        const switching = current !== null && current !== provider;
        const enrolled = !persist && stored === provider.sessionMarker;

        let material: KeyMaterial;
        try {
            material = await provider.arm(target, !enrolled, options.pin);
        } catch (error) {
            if (error instanceof ArmError) return { success: false, error: error.message };
            throw error;
        }

        sessionPasswords.delete(target.account);
        if (switching) await current.remove(target);

        if (seal) {
            await keytar?.setPassword(SERVICE_NAME, target.account, seal(password, material));
            console.info(`${provider.method} unlock stored persistently`);
            return { success: true };
        }

        // Session-scoped: keytar holds only the intent marker and the sealed
        // password stays in this process's memory
        sessionPasswords.set(target.account, { providerId: provider.id, target, sealed: provider.session.seal(password, material) });
        await keytar?.setPassword(SERVICE_NAME, target.account, provider.sessionMarker);
        console.info(`${provider.method} unlock armed for this session (${enrolled ? 're-arm' : 'first enrol'})`);
        return { success: true };
    } catch (error) {
        console.error('Failed to enable biometrics:', error);
        return { success: false, error: 'Failed to enable biometric authentication' };
    }
}

type UnlockResult = { success: boolean, error?: string, password?: string, retry?: boolean };

// The outcomes a refused release shares between the two scopes: a PIN typed
// wrong keeps the setup, one the provider gave up on (too many wrong PINs, key
// material deleted) takes the vault's enrollment with it
async function refusedRelease(provider: QuickUnlockProvider, account: string, error: unknown): Promise<UnlockResult> {
    if (error instanceof ReleaseError && error.reason === 'revoked') {
        sessionPasswords.delete(account);
        await keytar?.deletePassword(SERVICE_NAME, account);
        return { success: false, error: error.message };
    }
    if (error instanceof ReleaseError && error.reason === 'wrong-pin') {
        return { success: false, retry: true, error: error.message };
    }
    if (error instanceof ReleaseError && error.reason === 'canceled') {
        return { success: false, retry: true, error: 'Biometric authentication was cancelled' };
    }
    console.error(`${provider.method} authentication failed:`, error);
    return { success: false, retry: true, error: 'Biometric authentication failed' };
}

async function releaseSession(provider: QuickUnlockProvider, account: string, pin?: string): Promise<UnlockResult> {
    const entry = sessionPasswords.get(account);
    if (!entry || entry.providerId !== provider.id) {
        // Post-restart: nothing on disk can release the password, by
        // design. The password unlock re-arms this session
        return { success: false, retry: true, error: masterPasswordNeededMessage(provider) };
    }

    const binding = provider.session.binding(entry.sealed);
    let secret: Buffer;
    try {
        secret = await provider.release(entry.target, binding, pin);
    } catch (error) {
        // Key material that is gone (the keychain item went with a change of
        // enrolled fingerprints) never comes back, so the copy goes and the
        // next password unlock re-arms
        if (error instanceof ReleaseError && error.reason === 'gone') {
            sessionPasswords.delete(account);
            return { success: false, retry: true, error: masterPasswordNeededMessage(provider) };
        }
        return await refusedRelease(provider, account, error);
    }

    let password: string;
    try {
        password = provider.session.open(entry.sealed, secret);
    } catch {
        // Key material that no longer opens the copy (Hello was reset) never
        // will, so it goes and the next password unlock re-arms
        sessionPasswords.delete(account);
        return { success: false, retry: true, error: masterPasswordNeededMessage(provider) };
    }

    if (!getBiometricsConfig().requirePasswordAfterRestart) {
        try {
            const seal = provider.persistent.sealer();
            if (seal) {
                await keytar?.setPassword(SERVICE_NAME, account, seal(password, { secret, binding }));
                sessionPasswords.delete(account);
            }
        } catch (error) {
            console.error('Keeping a vault session-scoped, the persistent seal failed:', error);
        }
    }
    return { success: true, password };
}

async function releasePersistent(provider: QuickUnlockProvider, target: UnlockTarget, stored: string, pin?: string): Promise<UnlockResult> {
    const open = provider.persistent.opener();
    if (!open) {
        await keytar?.deletePassword(SERVICE_NAME, target.account);
        return { success: false, error: STALE_BLOB };
    }

    let secret: Buffer;
    try {
        secret = await provider.release(target, provider.persistent.binding(stored), pin);
    } catch (error) {
        if (error instanceof ReleaseError && error.reason === 'gone') {
            await keytar?.deletePassword(SERVICE_NAME, target.account);
            return { success: false, error: 'Biometric enrollment changed, please enable biometric unlock again' };
        }
        return await refusedRelease(provider, target.account, error);
    }

    try {
        return { success: true, password: open(stored, secret) };
    } catch {
        // Decryption failure means the key material changed (e.g. Hello
        // was reset); the blob is unrecoverable
        await keytar?.deletePassword(SERVICE_NAME, target.account);
        return { success: false, error: STALE_BLOB };
    }
}

// `retry` says the stored credential is still good and only this attempt
// failed (cancelled prompt, unrecognised finger). Without it the caller cannot
// tell that apart from credentials that can never be opened again, and tearing
// the user's biometric setup down every time they dismiss a prompt is wrong
export async function getBiometricPassword(dbPath: string, pin?: string): Promise<UnlockResult> {
    try {
        if (!await isBiometricsAvailable()) {
            return { success: false, error: UNAVAILABLE };
        }

        const target = await targetFor(dbPath);
        const stored = await keytar?.getPassword(SERVICE_NAME, target.account);
        if (!stored) {
            return { success: false, error: 'No password found for this database' };
        }

        const provider = providerForRecord(stored);
        if (!provider) {
            await discardOutdatedBlob(target.account);
            return { success: false, error: OUTDATED_BLOB };
        }

        if (stored === provider.sessionMarker) return await releaseSession(provider, target.account, pin);

        if (getBiometricsConfig().requirePasswordAfterRestart) {
            // The setting says nothing on disk may release the password. A
            // persistent blob from before it took effect is retired on the
            // spot, with the rest; the next password unlock re-arms
            await retireBlobOnSight(provider, target.account);
            return { success: false, retry: true, error: masterPasswordNeededMessage(provider) };
        }

        return await releasePersistent(provider, target, stored, pin);
    } catch (error) {
        console.error('Failed to get password with biometrics:', error);
        return { success: false, error: 'Failed to authenticate with biometrics', retry: true };
    }
}

export async function disableBiometrics(dbPath: string): Promise<{ success: boolean, error?: string }> {
    try {
        const target = await targetFor(dbPath);
        sessionPasswords.delete(target.account);
        await keytar?.deletePassword(SERVICE_NAME, target.account);
        for (const provider of platformProviders()) await provider.remove(target);
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
    methods: QuickUnlockMethod[],
    pinMinLength?: number,
    unavailableReason?: string
}> {
    if (!await isBiometricsAvailable()) return { available: false, backend: 'none', biometryType: 'none', methods: [] };

    const providers = supportedProviders();
    const usable: QuickUnlockProvider[] = [];
    let unavailableReason: string | undefined;
    for (const provider of providers) {
        const refusal = await provider.refusal();
        if (refusal) unavailableReason ??= refusal;
        else usable.push(provider);
    }

    if (usable.length === 0) {
        return { available: false, backend: 'none', biometryType: providers[0].biometryType(), methods: [], unavailableReason };
    }
    const pin = usable.find(provider => provider.needsPin);
    return {
        available: true,
        backend: 'hardware',
        biometryType: usable[0].biometryType(),
        methods: usable.map(provider => provider.id),
        ...(pin?.minPinLength ? { pinMinLength: await pin.minPinLength() } : {})
    };
}

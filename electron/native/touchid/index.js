// Loader and status interpretation for the Touch ID keychain addon.
// The addon is dormant unless it has been built AND the app is signed with
// the entitlements the data protection keychain requires (see README.md);
// when the compiled binary is absent every call reports
// { ok: false, code: 'unavailable' }.

const path = require('path');

const STATUS = {
    OK: 0,
    UNIMPLEMENTED: -4,
    USER_CANCELED: -128,
    AUTH_FAILED: -25293,
    DUPLICATE_ITEM: -25299,
    ITEM_NOT_FOUND: -25300,
    INTERACTION_NOT_ALLOWED: -25308,
    MISSING_ENTITLEMENT: -34018,
};

// LABiometryType, for telling the user which sensor they will be asked for
const BIOMETRY = { 0: 'none', 1: 'touch-id', 2: 'face-id', 4: 'optic-id' };

// Where the .node ends up differs between `npx node-gyp rebuild` in this
// directory (dev) and the packaged app, where it sits next to the bundled
// main process like the other native modules
function candidatePaths() {
    return [
        path.join(__dirname, 'build', 'Release', 'vigil_touchid.node'),
        path.join(__dirname, 'vigil_touchid.node'),
        path.join(__dirname, 'native_modules', 'vigil_touchid.node'),
    ];
}

function loadNative() {
    for (const candidate of candidatePaths()) {
        try {
            return require(candidate);
        } catch {
            // try the next location
        }
    }
    return null;
}

const native = loadNative();

// Pure: maps an OSStatus result to the outcome the app acts on
function interpret(result) {
    if (!result || typeof result.status !== 'number') return { ok: false, code: 'unavailable' };
    switch (result.status) {
        case STATUS.OK:
            return { ok: true, data: result.data };
        case STATUS.USER_CANCELED:
            return { ok: false, code: 'canceled' };
        case STATUS.AUTH_FAILED:
            return { ok: false, code: 'auth-failed' };
        case STATUS.ITEM_NOT_FOUND:
            return { ok: false, code: 'not-found' };
        case STATUS.DUPLICATE_ITEM:
            return { ok: false, code: 'duplicate' };
        // The silent operations report this when they would have had to
        // prompt; treated as a failed authentication rather than a missing
        // item so the caller does not wipe a good keychain entry
        case STATUS.INTERACTION_NOT_ALLOWED:
            return { ok: false, code: 'auth-failed' };
        case STATUS.MISSING_ENTITLEMENT:
            return { ok: false, code: 'missing-entitlement' };
        case STATUS.UNIMPLEMENTED:
            return { ok: false, code: 'unavailable' };
        default:
            return { ok: false, code: 'error', status: result.status };
    }
}

// Pure: what the addon's isAvailable() tells us about this machine
function describeAvailability(raw) {
    if (!raw || typeof raw !== 'object') {
        return { usable: false, biometry: false, devicePasscode: false, biometryType: 'none' };
    }
    return {
        // The ACL is "biometry OR passcode", so either one makes the keychain
        // item usable; without both, SecItemAdd would reject the ACL
        usable: !!(raw.biometry || raw.devicePasscode),
        biometry: !!raw.biometry,
        devicePasscode: !!raw.devicePasscode,
        biometryType: BIOMETRY[raw.biometryType] || 'none',
    };
}

// Pure: presence, which has a different status-to-meaning mapping than the
// operations that actually move data. A protected item that exists answers a
// non-interactive query with INTERACTION_NOT_ALLOWED, so that status is the
// signal that unlock IS set up, not a failure
function interpretPresence(result) {
    if (!result || typeof result.status !== 'number') return { ok: false, code: 'unavailable' };
    if (result.status === STATUS.OK || result.status === STATUS.INTERACTION_NOT_ALLOWED) {
        return { ok: true, present: true };
    }
    if (result.status === STATUS.ITEM_NOT_FOUND) {
        return { ok: true, present: false };
    }
    return interpret(result);
}

const unavailable = async () => ({ ok: false, code: 'unavailable' });

module.exports = {
    STATUS,
    interpret,
    interpretPresence,
    describeAvailability,
    isLoaded: () => native !== null,
    availability: () => (native ? describeAvailability(native.isAvailable()) : describeAvailability(null)),
    setSecret: native ? async (account, data) => interpret(await native.setSecret(account, data)) : unavailable,
    getSecret: native ? async (account, prompt) => interpret(await native.getSecret(account, prompt)) : unavailable,
    deleteSecret: native ? async (account) => interpret(await native.deleteSecret(account)) : unavailable,
    hasSecret: native ? async (account) => interpretPresence(await native.hasSecret(account)) : unavailable,
};

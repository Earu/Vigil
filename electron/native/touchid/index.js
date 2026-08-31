// Loader and status interpretation for the Touch ID keychain addon.
// The addon is dormant until built (see README.md); when the compiled
// binary is absent every call reports { ok: false, code: 'unavailable' }.

const path = require('path');

const STATUS = {
    OK: 0,
    UNIMPLEMENTED: -4,
    USER_CANCELED: -128,
    ITEM_NOT_FOUND: -25300,
    MISSING_ENTITLEMENT: -34018,
};

function loadNative() {
    try {
        return require(path.join(__dirname, 'build', 'Release', 'vigil_touchid.node'));
    } catch {
        return null;
    }
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
        case STATUS.ITEM_NOT_FOUND:
            return { ok: false, code: 'not-found' };
        case STATUS.MISSING_ENTITLEMENT:
            return { ok: false, code: 'missing-entitlement' };
        case STATUS.UNIMPLEMENTED:
            return { ok: false, code: 'unavailable' };
        default:
            return { ok: false, code: 'error', status: result.status };
    }
}

const unavailable = async () => ({ ok: false, code: 'unavailable' });

module.exports = {
    STATUS,
    interpret,
    isLoaded: () => native !== null,
    setSecret: native ? async (account, data) => interpret(await native.setSecret(account, data)) : unavailable,
    getSecret: native ? async (account, prompt) => interpret(await native.getSecret(account, prompt)) : unavailable,
    deleteSecret: native ? async (account) => interpret(await native.deleteSecret(account)) : unavailable,
};

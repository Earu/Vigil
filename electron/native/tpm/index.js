const path = require('path');

const TAMPERED = 0xfffffffd;
const BAD_INPUT = 0xfffffffe;
const UNIMPLEMENTED = 0xffffffff;

// NTE_PERM (0x80090010) is what the Platform Crypto Provider returns for a
// wrong PIN on Windows 11, and the TPM counts it as an authorization failure
const WIN = {
    NOT_FOUND: [0x80090016, 0x80090011],
    WRONG_PIN: [0x8028008e, 0x802800a2, 0x80280001, 0x8010006b, 0x80290107, 0x80090010],
    LOCKED_OUT: [0x80280921, 0x80280803, 0x8010006c],
    UNAVAILABLE: [0x80090030, 0x80090029, 0x8028400f, 0x80290101, 0x80290100],
};

const TSS2_LAYER_MASK = 0xff0000;
const TSS2_TPM_LAYERS = [0x000000, 0x0b0000, 0x0c0000];
const TSS2_CONNECTION_LAYERS = [0x070000, 0x080000, 0x0a0000];
const TPM2_RC_FMT1 = 0x080;
const TPM2_RC_AUTH_FAIL = 0x08e;
const TPM2_RC_BAD_AUTH = 0x0a2;
const TPM2_RC_INTEGRITY = 0x09f;
const TPM2_RC_LOCKOUT = 0x921;

function interpretWindows(status) {
    if (WIN.NOT_FOUND.includes(status)) return 'not-found';
    if (WIN.WRONG_PIN.includes(status)) return 'wrong-pin';
    if (WIN.LOCKED_OUT.includes(status)) return 'locked-out';
    if (WIN.UNAVAILABLE.includes(status)) return 'unavailable';
    return 'error';
}

function interpretLinux(status) {
    const layer = status & TSS2_LAYER_MASK;
    if (TSS2_TPM_LAYERS.includes(layer)) {
        const base = status & 0xffff;
        if (base & TPM2_RC_FMT1) {
            const code = base & 0xbf;
            if (code === TPM2_RC_AUTH_FAIL || code === TPM2_RC_BAD_AUTH) return 'wrong-pin';
            if (code === TPM2_RC_INTEGRITY) return 'not-found';
        } else if ((base & 0xfff) === TPM2_RC_LOCKOUT) {
            return 'locked-out';
        }
        return 'error';
    }
    if (TSS2_CONNECTION_LAYERS.includes(layer)) return 'unavailable';
    return 'error';
}

function interpret(platform, status) {
    if (status === 0) return 'ok';
    if (status === TAMPERED) return 'tampered';
    if (status === BAD_INPUT) return 'bad-input';
    if (status === UNIMPLEMENTED) return 'unavailable';
    if (platform === 'win') return interpretWindows(status);
    if (platform === 'linux') return interpretLinux(status);
    return 'unavailable';
}

function candidatePaths() {
    return [
        ...(process.resourcesPath ? [path.join(process.resourcesPath, 'native', 'vigil_tpm.node')] : []),
        path.join(__dirname, 'build', 'Release', 'vigil_tpm.node'),
        path.join(__dirname, 'vigil_tpm.node'),
        path.join(__dirname, 'native_modules', 'vigil_tpm.node'),
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
const platform = native ? native.platform : 'none';

function outcome(result, field) {
    const status = result && typeof result.status === 'number' ? result.status >>> 0 : UNIMPLEMENTED;
    const code = interpret(platform, status);
    if (code === 'ok') return { ok: true, [field]: result.data ?? Buffer.alloc(0) };
    return { ok: false, code, status };
}

const unavailable = async () => ({ ok: false, code: 'unavailable', status: UNIMPLEMENTED });

const TPMA_PERMANENT_LOCKOUTAUTHSET = 0x4;

function parseLockout(data) {
    if (!Buffer.isBuffer(data) || data.length !== 12) return { ok: false, code: 'error', status: BAD_INPUT };
    return {
        ok: true,
        lockoutAuthSet: (data.readUInt32BE(0) & TPMA_PERMANENT_LOCKOUTAUTHSET) !== 0,
        maxTries: data.readUInt32BE(4),
        recoveryInterval: data.readUInt32BE(8),
    };
}

async function lockout() {
    const result = outcome(await native.lockout(), 'data');
    return result.ok ? parseLockout(result.data) : result;
}

module.exports = {
    interpret,
    parseLockout,
    platform,
    isLoaded: () => native !== null,
    probe: () => {
        const status = native ? native.probe() >>> 0 : UNIMPLEMENTED;
        const code = interpret(platform, status);
        return code === 'ok' ? { ok: true } : { ok: false, code, status };
    },
    seal: native ? async (name, data, pin) => outcome(await native.seal(name, data, pin), 'sealed') : unavailable,
    unseal: native ? async (name, pin, sealed) => outcome(await native.unseal(name, pin, sealed), 'data') : unavailable,
    remove: native ? async (name) => outcome(await native.remove(name), 'data') : unavailable,
    lockout: native && typeof native.lockout === 'function' ? lockout : unavailable,
};

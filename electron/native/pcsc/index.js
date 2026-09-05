// Loader and return-code interpretation for the PC/SC transport addon.
// The addon hands back raw PC/SC return codes; every name they get, and the
// decision that some of them are ordinary states rather than failures, is
// made here where the tests can reach it. When the compiled binary is
// absent, isLoaded() is false and every operation rejects with 'unavailable'.

const path = require('path');

// WinSCard return codes, as their unsigned 32-bit values. The same numbers
// on every platform; pcsclite copies them from Microsoft's header
const RV = {
    SUCCESS: 0x00000000,
    CANCELLED: 0x80100002,
    INVALID_HANDLE: 0x80100003,
    INVALID_PARAMETER: 0x80100004,
    TIMEOUT: 0x8010000a,
    SHARING_VIOLATION: 0x8010000b,
    NO_SMARTCARD: 0x8010000c,
    UNKNOWN_CARD: 0x8010000d,
    PROTO_MISMATCH: 0x8010000f,
    NOT_READY: 0x80100010,
    NOT_TRANSACTED: 0x80100016,
    READER_UNAVAILABLE: 0x80100017,
    NO_SERVICE: 0x8010001d,
    SERVICE_STOPPED: 0x8010001e,
    UNKNOWN_READER: 0x80100009,
    NO_READERS_AVAILABLE: 0x8010002e,
    COMM_DATA_LOST: 0x8010002f,
    UNSUPPORTED_CARD: 0x80100065,
    UNRESPONSIVE_CARD: 0x80100066,
    UNPOWERED_CARD: 0x80100067,
    RESET_CARD: 0x80100068,
    REMOVED_CARD: 0x80100069,
};

// Where the .node ends up differs between `npx node-gyp rebuild` in this
// directory (dev) and the packaged app, where it sits next to the bundled
// main process like the other native modules
function candidatePaths() {
    return [
        path.join(__dirname, 'build', 'Release', 'vigil_pcsc.node'),
        path.join(__dirname, 'vigil_pcsc.node'),
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

// Pure: the name a return code goes by in the rest of the app. Anything not
// listed is 'pcsc-error', with the raw value kept for the log
function interpret(rv) {
    switch (rv) {
        case RV.SUCCESS: return 'ok';
        case RV.NO_SERVICE:
        case RV.SERVICE_STOPPED: return 'no-service';
        case RV.NO_READERS_AVAILABLE:
        case RV.UNKNOWN_READER:
        case RV.READER_UNAVAILABLE: return 'no-reader';
        case RV.NO_SMARTCARD:
        case RV.REMOVED_CARD:
        case RV.UNPOWERED_CARD:
        case RV.UNRESPONSIVE_CARD: return 'no-card';
        case RV.RESET_CARD: return 'reset';
        case RV.SHARING_VIOLATION: return 'sharing-violation';
        case RV.PROTO_MISMATCH: return 'proto-mismatch';
        case RV.NOT_TRANSACTED: return 'not-transacted';
        case RV.TIMEOUT: return 'timeout';
        case RV.CANCELLED: return 'cancelled';
        default: return 'pcsc-error';
    }
}

class PcscError extends Error {
    constructor(code, rv) {
        super(rv === undefined ? code : `${code} (0x${rv.toString(16).padStart(8, '0')})`);
        this.name = 'PcscError';
        this.code = code;
        this.rv = rv;
    }
}

const unavailable = () => Promise.reject(new PcscError('unavailable'));

// Resolves the payload, or rejects with the interpreted code
async function unwrap(promise) {
    const result = await promise;
    if (result.rv !== RV.SUCCESS) throw new PcscError(interpret(result.rv), result.rv);
    return result;
}

// One connection. PC/SC does not define what happens when two calls hit the
// same handle at once, so a second call while one is in flight is refused
// here rather than left to the driver's discretion
class Card {
    constructor(handle, protocol) {
        this.handle = handle;
        this.protocol = protocol;
        this.busy = false;
        this.closed = false;
    }

    async run(op, ...args) {
        if (this.closed) throw new PcscError('closed');
        if (this.busy) throw new PcscError('busy');
        this.busy = true;
        try {
            return await unwrap(native[op](this.handle, ...args));
        } finally {
            this.busy = false;
        }
    }

    async transmit(apdu) {
        const { data } = await this.run('transmit', Buffer.from(apdu));
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    beginTransaction() { return this.run('beginTransaction').then(() => undefined); }
    endTransaction() { return this.run('endTransaction').then(() => undefined); }

    async disconnect() {
        if (this.closed) return;
        // Refused rather than deferred: a disconnect under an in-flight call
        // would leave the handle in the table and the card's transaction open
        if (this.busy) throw new PcscError('busy');
        // Marked closed first: whatever disconnect reports, the handle is gone
        this.closed = true;
        await unwrap(native.disconnect(this.handle));
    }
}

module.exports = {
    RV,
    PcscError,
    interpret,
    isLoaded: () => native !== null,
    listReaders: native
        ? async () => (await unwrap(native.listReaders())).readers
        : unavailable,
    connect: native
        ? async (reader, { shared = true } = {}) => {
            const { handle, protocol } = await unwrap(native.connect(reader, shared));
            return new Card(handle, protocol);
        }
        : unavailable,
};

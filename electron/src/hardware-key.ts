import { join } from 'path';

// YubiKey OTP HID challenge-response driver, ported from KeePassXC's vendored
// ykcore. The OTP application speaks 8-byte feature reports: bytes 0-6 carry
// payload, byte 7 carries flags and a 5-bit sequence number.

export const YUBICO_VID = 0x1050;
export const FEATURE_RPT_SIZE = 8;
export const SLOT_DATA_SIZE = 64;
export const SLOT_DEVICE_SERIAL = 0x10;
export const SLOT_CHAL_HMAC1 = 0x30;
export const SLOT_CHAL_HMAC2 = 0x38;
export const SLOT_WRITE_FLAG = 0x80;
export const RESP_PENDING_FLAG = 0x40;
export const RESP_TIMEOUT_WAIT_FLAG = 0x20;
export const DUMMY_REPORT_WRITE = 0x8f;
export const CRC_OK_RESIDUAL = 0xf0b8;
export const HMAC_RESPONSE_SIZE = 20;

const CONFIG1_VALID = 0x01;
const CONFIG2_VALID = 0x02;
// Worst-case slot swap is 920ms, plus 25% margin (ykcore)
const WAIT_FOR_WRITE_MS = 1150;
const RESP_WAIT_MS = 2000;
// How long the user gets to touch the key once it starts blinking
const TOUCH_WAIT_MS = 30000;
const MAX_RESPONSE_BUF = 70;

export interface HardwareKeyInfo {
    path: string;
    product: string;
    serial: number | null;
    slot1Configured: boolean;
    slot2Configured: boolean;
}

interface HidDeviceInfo {
    vendorId: number;
    productId: number;
    path?: string;
    product?: string;
    interface: number;
    usagePage?: number;
    usage?: number;
}

export interface HidAsyncDevice {
    sendFeatureReport(data: number[] | Buffer): Promise<number>;
    getFeatureReport(reportId: number, length: number): Promise<Buffer | number[]>;
    close(): Promise<void>;
}

interface HidApi {
    devices(): HidDeviceInfo[];
    open(path: string): Promise<HidAsyncDevice>;
}

// macOS: hidapi seizes devices by default, and seizing a keyboard-class
// device (which the OTP interface is) needs root; non-exclusive open only
// needs the Input Monitoring permission. Ignored on other platforms.
const OPEN_OPTS = { nonExclusive: true };

let hidApi: HidApi | null | undefined;

function loadHid(): HidApi | null {
    if (hidApi !== undefined) return hidApi;
    try {
        if (process.env.NODE_ENV === 'development') {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require('node-hid');
            hidApi = { devices: () => mod.devices(), open: (path: string) => mod.HIDAsync.open(path, OPEN_OPTS) };
        } else {
            // The raw N-API binding: same devices()/openAsyncHIDDevice() the
            // node-hid wrapper delegates to
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const binding = require(join(__dirname, 'node-hid.node'));
            hidApi = { devices: () => binding.devices(), open: async (path: string) => binding.openAsyncHIDDevice(path, OPEN_OPTS) };
        }
    } catch (error) {
        console.error('Failed to load node-hid:', error);
        hidApi = null;
    }
    return hidApi;
}

export class HardwareKeyError extends Error {
    constructor(code: string) {
        super(code);
        this.name = 'HardwareKeyError';
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function crc16(data: Uint8Array): number {
    let crc = 0xffff;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            const lsb = crc & 1;
            crc >>= 1;
            if (lsb) crc ^= 0x8408;
        }
    }
    return crc;
}

// The challenge must always fill the 64-byte payload: a key configured for
// variable-length input hashes whatever arrives, so KeePassXC pads PKCS7-style
// and we must pad identically to produce the same responses
export function padChallenge(challenge: Uint8Array): Uint8Array {
    const padded = new Uint8Array(SLOT_DATA_SIZE);
    const len = Math.min(challenge.length, SLOT_DATA_SIZE);
    padded.set(challenge.subarray(0, len));
    padded.fill(SLOT_DATA_SIZE - len, len);
    return padded;
}

// Frame: payload[64] + slot command + CRC16 of the payload (little-endian) +
// 3 filler bytes
export function buildFrame(slotCmd: number, payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(SLOT_DATA_SIZE + 6);
    frame.set(payload.subarray(0, SLOT_DATA_SIZE));
    frame[SLOT_DATA_SIZE] = slotCmd;
    const crc = crc16(frame.subarray(0, SLOT_DATA_SIZE));
    frame[SLOT_DATA_SIZE + 1] = crc & 0xff;
    frame[SLOT_DATA_SIZE + 2] = (crc >> 8) & 0xff;
    return frame;
}

// Split a frame into feature reports: 7 payload bytes plus a sequence byte
// with SLOT_WRITE_FLAG set. All-zero chunks are skipped except the first and
// last (ykcore's transfer speedup, the key tolerates gaps in the sequence)
export function frameReports(frame: Uint8Array): Uint8Array[] {
    const reports: Uint8Array[] = [];
    const total = Math.ceil(frame.length / (FEATURE_RPT_SIZE - 1));
    for (let seq = 0; seq < total; seq++) {
        const chunk = frame.subarray(seq * 7, seq * 7 + 7);
        const allZero = chunk.every((byte) => byte === 0);
        if (allZero && seq > 0 && seq < total - 1) continue;
        const report = new Uint8Array(FEATURE_RPT_SIZE);
        report.set(chunk);
        report[FEATURE_RPT_SIZE - 1] = seq | SLOT_WRITE_FLAG;
        reports.push(report);
    }
    return reports;
}

export class YubiKey {
    private readonly touchWaitMs: number;
    private readonly respWaitMs: number;

    constructor(
        private readonly dev: HidAsyncDevice,
        opts: { touchWaitMs?: number; respWaitMs?: number } = {}
    ) {
        this.touchWaitMs = opts.touchWaitMs ?? TOUCH_WAIT_MS;
        this.respWaitMs = opts.respWaitMs ?? RESP_WAIT_MS;
    }

    private async readReport(): Promise<Uint8Array> {
        const raw = await this.dev.getFeatureReport(0, FEATURE_RPT_SIZE + 1);
        const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : Uint8Array.from(raw as ArrayLike<number>);
        if (bytes.length < FEATURE_RPT_SIZE) throw new HardwareKeyError('HARDWARE_KEY_READ_FAILED');
        // hidapi keeps the report-id prefix byte on Windows/macOS and strips
        // it on Linux
        return bytes.length > FEATURE_RPT_SIZE ? bytes.subarray(1, 1 + FEATURE_RPT_SIZE) : bytes;
    }

    private async writeReport(report: Uint8Array): Promise<void> {
        const buf = Buffer.alloc(FEATURE_RPT_SIZE + 1);
        Buffer.from(report).copy(buf, 1);
        await this.dev.sendFeatureReport(buf);
    }

    // Invalid sequence number = "update only": clears the key's read state
    private async reset(): Promise<void> {
        const report = new Uint8Array(FEATURE_RPT_SIZE);
        report[FEATURE_RPT_SIZE - 1] = DUMMY_REPORT_WRITE;
        await this.writeReport(report).catch(() => { /* best effort */ });
    }

    // Idle report layout: [0] pad, [1-3] firmware version, [4] pgmSeq,
    // [5-6] touchLevel little-endian (slot-configured bits), [7] flags
    public async status(): Promise<{ version: string; slot1Configured: boolean; slot2Configured: boolean }> {
        const report = await this.readReport();
        const touchLevel = report[5] | (report[6] << 8);
        return {
            version: `${report[1]}.${report[2]}.${report[3]}`,
            slot1Configured: (touchLevel & CONFIG1_VALID) !== 0,
            slot2Configured: (touchLevel & CONFIG2_VALID) !== 0,
        };
    }

    private async waitStatus(
        maxTimeMs: number,
        waitForSet: boolean,
        mask: number,
        opts: { mayBlock?: boolean; onTouch?: () => void } = {}
    ): Promise<Uint8Array> {
        let sleepMs = 1;
        let slept = 0;
        let blocking = false;
        while (slept < maxTimeMs) {
            await sleep(sleepMs);
            slept += sleepMs;
            sleepMs = Math.min(sleepMs * 2, 500);
            const report = await this.readReport();
            const flags = report[FEATURE_RPT_SIZE - 1];
            if (waitForSet ? (flags & mask) === mask : (flags & mask) === 0) {
                return report;
            }
            if ((flags & RESP_TIMEOUT_WAIT_FLAG) !== 0) {
                if (!opts.mayBlock) {
                    await this.reset();
                    throw new HardwareKeyError('HARDWARE_KEY_TOUCH_REQUIRED');
                }
                if (!blocking) {
                    blocking = true;
                    maxTimeMs += this.touchWaitMs;
                    opts.onTouch?.();
                }
            } else if (blocking) {
                // The key gave up waiting for a touch
                break;
            }
        }
        // A touch wait that expired is not the same failure as a slot that
        // never answered (wrong slot selected, OTP-configured slot, ...)
        throw new HardwareKeyError(blocking ? 'HARDWARE_KEY_TOUCH_TIMEOUT' : 'HARDWARE_KEY_TIMEOUT');
    }

    private async writeFrame(slotCmd: number, payload: Uint8Array): Promise<void> {
        for (const report of frameReports(buildFrame(slotCmd, payload))) {
            // The key clears SLOT_WRITE_FLAG when ready for the next part
            await this.waitStatus(WAIT_FOR_WRITE_MS, false, SLOT_WRITE_FLAG);
            await this.writeReport(report);
        }
    }

    private async readResponse(
        expectBytes: number,
        opts: { mayBlock?: boolean; onTouch?: () => void }
    ): Promise<Uint8Array> {
        const first = await this.waitStatus(this.respWaitMs, true, RESP_PENDING_FLAG, opts);
        const buf: number[] = Array.from(first.subarray(0, FEATURE_RPT_SIZE - 1));
        while (buf.length + FEATURE_RPT_SIZE <= MAX_RESPONSE_BUF) {
            const report = await this.readReport();
            const flags = report[FEATURE_RPT_SIZE - 1];
            if ((flags & RESP_PENDING_FLAG) === 0) {
                await this.reset();
                throw new HardwareKeyError('HARDWARE_KEY_READ_FAILED');
            }
            // The lower five bits carry the sequence number; back to zero
            // means the response is complete
            if ((flags & 31) === 0) {
                await this.reset();
                const total = expectBytes + 2;
                if (buf.length < total || crc16(Uint8Array.from(buf.slice(0, total))) !== CRC_OK_RESIDUAL) {
                    throw new HardwareKeyError('HARDWARE_KEY_BAD_CRC');
                }
                return Uint8Array.from(buf.slice(0, expectBytes));
            }
            buf.push(...report.subarray(0, FEATURE_RPT_SIZE - 1));
        }
        await this.reset();
        throw new HardwareKeyError('HARDWARE_KEY_READ_FAILED');
    }

    public async serial(): Promise<number | null> {
        try {
            await this.writeFrame(SLOT_DEVICE_SERIAL, new Uint8Array(0));
            const resp = await this.readResponse(4, { mayBlock: false });
            // Big-endian, unlike everything else on the key
            return ((resp[0] << 24) | (resp[1] << 16) | (resp[2] << 8) | resp[3]) >>> 0;
        } catch {
            // Serial API can be disabled by configuration
            return null;
        }
    }

    public async challengeResponse(slot: 1 | 2, challenge: Uint8Array, onTouch?: () => void): Promise<Uint8Array> {
        const cmd = slot === 1 ? SLOT_CHAL_HMAC1 : SLOT_CHAL_HMAC2;
        await this.writeFrame(cmd, padChallenge(challenge));
        return await this.readResponse(HMAC_RESPONSE_SIZE, { mayBlock: true, onTouch });
    }
}

// The OTP application lives on the keyboard interface (usage page 1, usage 6);
// older node-hid builds may not report usages, so fall back to interface 0
function candidates(hid: HidApi): HidDeviceInfo[] {
    const all = hid.devices().filter((d) => d.vendorId === YUBICO_VID && d.path);
    const byUsage = all.filter((d) => d.usagePage === 1 && d.usage === 6);
    const chosen = byUsage.length > 0 ? byUsage : all.filter((d) => d.interface === 0);
    const seen = new Set<string>();
    return chosen.filter((d) => !seen.has(d.path!) && seen.add(d.path!));
}

// Cheap presence probe: pure enumeration, no device is opened, so it is safe
// to poll while a challenge is in flight
// Any Yubico device on the HID bus, whichever applications are enabled.
// hardwareKeyPresent below is narrower on purpose: challenge-response needs
// the OTP interface specifically. OATH does not, so a key with OTP disabled
// still counts here as long as FIDO is on. A key with OTP and FIDO both
// disabled exposes no HID interface at all and is invisible to this
export function yubicoDevicePresent(): boolean {
    const hid = loadHid();
    if (!hid) return false;
    try {
        return hid.devices().some(d => d.vendorId === YUBICO_VID);
    } catch {
        return false;
    }
}

export function hardwareKeyPresent(): boolean {
    const hid = loadHid();
    if (!hid) return false;
    try {
        return candidates(hid).length > 0;
    } catch {
        return false;
    }
}

export function listHardwareKeys(): Promise<{ keys: HardwareKeyInfo[]; blocked: boolean }> {
    return enqueue(() => doListHardwareKeys());
}

async function doListHardwareKeys(): Promise<{ keys: HardwareKeyInfo[]; blocked: boolean }> {
    const hid = loadHid();
    if (!hid) return { keys: [], blocked: false };
    const keys: HardwareKeyInfo[] = [];
    let openFailures = 0;
    let found = 0;
    for (const info of candidates(hid)) {
        found++;
        let dev: HidAsyncDevice;
        try {
            dev = await hid.open(info.path!);
        } catch {
            openFailures++;
            continue;
        }
        try {
            const yk = new YubiKey(dev);
            const status = await yk.status();
            const serial = await yk.serial();
            keys.push({
                path: info.path!,
                product: info.product || 'YubiKey',
                serial,
                slot1Configured: status.slot1Configured,
                slot2Configured: status.slot2Configured,
            });
        } catch { /* not a usable OTP interface */ } finally {
            await dev.close().catch(() => { /* ignore */ });
        }
    }
    return { keys, blocked: found > 0 && keys.length === 0 && openFailures > 0 };
}

// One operation at a time: the key's slot state machine is global, and a
// device scan or a second vault window must not interleave reports with a
// challenge in flight
let pendingOp: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = pendingOp
        .catch(() => { /* previous failure is not ours */ })
        .then(op);
    pendingOp = run;
    return run;
}

export function hardwareKeyChallenge(
    serial: number | null,
    slot: 1 | 2,
    challenge: Uint8Array,
    onTouch?: () => void
): Promise<Uint8Array> {
    return enqueue(() => doChallenge(serial, slot, challenge, onTouch));
}

async function doChallenge(
    serial: number | null,
    slot: 1 | 2,
    challenge: Uint8Array,
    onTouch?: () => void
): Promise<Uint8Array> {
    const hid = loadHid();
    if (!hid) throw new HardwareKeyError('HARDWARE_KEY_UNAVAILABLE');
    const infos = candidates(hid);
    if (infos.length === 0) throw new HardwareKeyError('HARDWARE_KEY_NOT_FOUND');
    let lastError: unknown = new HardwareKeyError('HARDWARE_KEY_NOT_FOUND');
    for (const info of infos) {
        let dev: HidAsyncDevice;
        try {
            dev = await hid.open(info.path!);
        } catch {
            lastError = new HardwareKeyError('HARDWARE_KEY_ACCESS_DENIED');
            continue;
        }
        const yk = new YubiKey(dev);
        try {
            if (serial != null) {
                const devSerial = await yk.serial();
                if (devSerial != null && devSerial !== serial) continue;
            }
            return await yk.challengeResponse(slot, challenge, onTouch);
        } catch (error) {
            lastError = error;
        } finally {
            await dev.close().catch(() => { /* ignore */ });
        }
    }
    throw lastError;
}

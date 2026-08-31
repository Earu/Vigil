import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
    crc16,
    padChallenge,
    buildFrame,
    frameReports,
    YubiKey,
    HidAsyncDevice,
    CRC_OK_RESIDUAL,
    SLOT_CHAL_HMAC1,
    SLOT_CHAL_HMAC2,
    SLOT_DEVICE_SERIAL,
    SLOT_WRITE_FLAG,
    RESP_PENDING_FLAG,
    RESP_TIMEOUT_WAIT_FLAG,
    DUMMY_REPORT_WRITE,
    SLOT_DATA_SIZE,
    FEATURE_RPT_SIZE,
} from '../electron/src/hardware-key';

const HMAC_SECRET = Buffer.from('303132333435363738393a3b3c3d3e3f40414243', 'hex');

// Emulates the YubiKey OTP application's feature-report state machine
class FakeYubiKey implements HidAsyncDevice {
    public lastPayload: Uint8Array | null = null;
    public lastSlotCmd: number | null = null;
    public frameCrcValid = false;
    public serialNumber = 12345678;
    public touchReads = 0; // reads that report touch-wait before responding
    public windowsStyle = false; // include the report-id prefix byte on reads
    public deadSlot = false; // accept the frame but never respond (OTP slot)

    private frame = new Uint8Array(SLOT_DATA_SIZE + 6);
    private seenLastChunk = false;
    private mode: 'idle' | 'touchwait' | 'respond' = 'idle';
    private chunks: Uint8Array[] = [];
    private chunkIdx = 0;
    private touchRemaining = 0;

    async sendFeatureReport(data: number[] | Buffer): Promise<number> {
        const buf = Buffer.from(data);
        const report = buf.subarray(1); // strip report id
        const status = report[FEATURE_RPT_SIZE - 1];
        if (status === DUMMY_REPORT_WRITE) {
            this.mode = 'idle';
            this.chunks = [];
            this.chunkIdx = 0;
            this.frame.fill(0);
            this.seenLastChunk = false;
            return buf.length;
        }
        if (status & SLOT_WRITE_FLAG) {
            const seq = status & 0x1f;
            this.frame.set(report.subarray(0, 7), seq * 7);
            if (seq === 9) {
                this.seenLastChunk = true;
                this.processFrame();
            }
        }
        return buf.length;
    }

    async getFeatureReport(_reportId: number, _length: number): Promise<Buffer> {
        const report = this.nextReport();
        return this.windowsStyle ? Buffer.concat([Buffer.from([0]), report]) : Buffer.from(report);
    }

    async close(): Promise<void> { /* nothing to release */ }

    private nextReport(): Buffer {
        const report = Buffer.alloc(FEATURE_RPT_SIZE);
        if (this.mode === 'touchwait') {
            this.touchRemaining--;
            if (this.touchRemaining <= 0) this.mode = 'respond';
            report[FEATURE_RPT_SIZE - 1] = RESP_TIMEOUT_WAIT_FLAG;
            return report;
        }
        if (this.mode === 'respond') {
            if (this.chunkIdx < this.chunks.length) {
                report.set(this.chunks[this.chunkIdx], 0);
                report[FEATURE_RPT_SIZE - 1] = RESP_PENDING_FLAG | ((this.chunkIdx + 1) & 0x1f);
                this.chunkIdx++;
            } else {
                // sequence back to zero: response complete
                report[FEATURE_RPT_SIZE - 1] = RESP_PENDING_FLAG;
            }
            return report;
        }
        // Idle status block: pad, firmware version, pgmSeq, touchLevel LE, flags
        report.set([0, 5, 4, 3, 1, 0x03, 0x00, 0]);
        return report;
    }

    private processFrame(): void {
        const payload = this.frame.subarray(0, SLOT_DATA_SIZE);
        const slotCmd = this.frame[SLOT_DATA_SIZE];
        const wireCrc = this.frame[SLOT_DATA_SIZE + 1] | (this.frame[SLOT_DATA_SIZE + 2] << 8);
        this.frameCrcValid = crc16(payload) === wireCrc;
        this.lastPayload = payload.slice();
        this.lastSlotCmd = slotCmd;

        if (this.deadSlot) return;

        let response: Buffer;
        if (slotCmd === SLOT_CHAL_HMAC1 || slotCmd === SLOT_CHAL_HMAC2) {
            response = createHmac('sha1', HMAC_SECRET).update(payload).digest();
        } else if (slotCmd === SLOT_DEVICE_SERIAL) {
            response = Buffer.alloc(4);
            response.writeUInt32BE(this.serialNumber);
        } else {
            return; // unknown command: stay idle
        }

        // The key appends the complemented CRC so the verifier's running CRC
        // over payload+crc lands on the 0xf0b8 residual
        const crc = ~crc16(response) & 0xffff;
        const framed = Buffer.concat([response, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
        this.chunks = [];
        for (let i = 0; i < framed.length; i += 7) {
            const chunk = new Uint8Array(7);
            chunk.set(framed.subarray(i, i + 7));
            this.chunks.push(chunk);
        }
        this.chunkIdx = 0;
        if (this.touchReads > 0 && slotCmd !== SLOT_DEVICE_SERIAL) {
            this.touchRemaining = this.touchReads;
            this.mode = 'touchwait';
        } else {
            this.mode = 'respond';
        }
    }
}

describe('crc16', () => {
    it('matches the ISO 13239 residual property', () => {
        const data = Uint8Array.from({ length: 20 }, (_, i) => i * 7 + 3);
        const crc = ~crc16(data) & 0xffff;
        const framed = Uint8Array.from([...data, crc & 0xff, (crc >> 8) & 0xff]);
        expect(crc16(framed)).toBe(CRC_OK_RESIDUAL);
    });

    it('starts at 0xffff for empty input', () => {
        expect(crc16(new Uint8Array(0))).toBe(0xffff);
    });
});

describe('padChallenge', () => {
    it('pads a 32-byte challenge PKCS7-style to 64 bytes', () => {
        const padded = padChallenge(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
        expect(padded.length).toBe(64);
        expect(padded[0]).toBe(1);
        expect(padded[31]).toBe(32);
        for (let i = 32; i < 64; i++) expect(padded[i]).toBe(32);
    });

    it('leaves a 64-byte challenge untouched', () => {
        const input = Uint8Array.from({ length: 64 }, () => 0xab);
        expect(Array.from(padChallenge(input))).toEqual(Array.from(input));
    });
});

describe('frame building', () => {
    it('places slot command and little-endian CRC after the payload', () => {
        const payload = Uint8Array.from({ length: 64 }, (_, i) => i);
        const frame = buildFrame(SLOT_CHAL_HMAC2, payload);
        expect(frame.length).toBe(70);
        expect(frame[64]).toBe(SLOT_CHAL_HMAC2);
        const crc = crc16(payload);
        expect(frame[65]).toBe(crc & 0xff);
        expect(frame[66]).toBe((crc >> 8) & 0xff);
    });

    it('splits a dense frame into 10 write reports with sequence bytes', () => {
        const frame = buildFrame(SLOT_CHAL_HMAC2, Uint8Array.from({ length: 64 }, () => 0x55));
        const reports = frameReports(frame);
        expect(reports.length).toBe(10);
        reports.forEach((report, i) => {
            expect(report.length).toBe(8);
            expect(report[7]).toBe(i | SLOT_WRITE_FLAG);
        });
    });

    it('skips all-zero middle chunks but keeps the first and last', () => {
        const frame = buildFrame(SLOT_DEVICE_SERIAL, new Uint8Array(0));
        const reports = frameReports(frame);
        const seqs = reports.map((r) => r[7] & 0x1f);
        expect(seqs[0]).toBe(0);
        expect(seqs[seqs.length - 1]).toBe(9);
        // 64 zero payload bytes: chunks 1-8 are all zero and droppable
        expect(reports.length).toBeLessThan(10);
    });
});

describe('YubiKey driver against a fake device', () => {
    it('runs an HMAC challenge-response round trip', async () => {
        const fake = new FakeYubiKey();
        const yk = new YubiKey(fake);
        const challenge = Uint8Array.from({ length: 32 }, (_, i) => i);
        const response = await yk.challengeResponse(2, challenge);

        expect(fake.lastSlotCmd).toBe(SLOT_CHAL_HMAC2);
        expect(fake.frameCrcValid).toBe(true);
        const expected = createHmac('sha1', HMAC_SECRET).update(padChallenge(challenge)).digest();
        expect(Buffer.from(response).equals(expected)).toBe(true);
    });

    it('sends the PKCS7-padded challenge over the wire', async () => {
        const fake = new FakeYubiKey();
        const yk = new YubiKey(fake);
        const challenge = Uint8Array.from({ length: 32 }, () => 0x11);
        await yk.challengeResponse(1, challenge);

        expect(fake.lastSlotCmd).toBe(SLOT_CHAL_HMAC1);
        expect(fake.lastPayload).not.toBeNull();
        for (let i = 32; i < 64; i++) expect(fake.lastPayload![i]).toBe(32);
    });

    it('normalizes reports that include the report-id prefix byte', async () => {
        const fake = new FakeYubiKey();
        fake.windowsStyle = true;
        const yk = new YubiKey(fake);
        const challenge = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
        const response = await yk.challengeResponse(2, challenge);
        const expected = createHmac('sha1', HMAC_SECRET).update(padChallenge(challenge)).digest();
        expect(Buffer.from(response).equals(expected)).toBe(true);
    });

    it('reports touch waits once and still completes', async () => {
        const fake = new FakeYubiKey();
        fake.touchReads = 3;
        const yk = new YubiKey(fake);
        let touches = 0;
        const response = await yk.challengeResponse(2, new Uint8Array(32), () => touches++);
        expect(touches).toBe(1);
        expect(response.length).toBe(20);
    });

    it('distinguishes a dead slot from an expired touch wait', async () => {
        const dead = new FakeYubiKey();
        dead.deadSlot = true;
        const ykDead = new YubiKey(dead, { respWaitMs: 100 });
        await expect(ykDead.challengeResponse(2, new Uint8Array(32))).rejects.toMatchObject({
            message: 'HARDWARE_KEY_TIMEOUT',
        });

        const blinking = new FakeYubiKey();
        blinking.touchReads = 100000; // never satisfied
        const ykBlink = new YubiKey(blinking, { respWaitMs: 60, touchWaitMs: 120 });
        let touched = 0;
        await expect(ykBlink.challengeResponse(2, new Uint8Array(32), () => touched++)).rejects.toMatchObject({
            message: 'HARDWARE_KEY_TOUCH_TIMEOUT',
        });
        expect(touched).toBe(1);
    });

    it('reads the serial number big-endian', async () => {
        const fake = new FakeYubiKey();
        fake.serialNumber = 87654321;
        const yk = new YubiKey(fake);
        expect(await yk.serial()).toBe(87654321);
    });

    it('parses slot configuration from the status block', async () => {
        const fake = new FakeYubiKey();
        const yk = new YubiKey(fake);
        const status = await yk.status();
        expect(status.slot1Configured).toBe(true);
        expect(status.slot2Configured).toBe(true);
        expect(status.version).toBe('5.4.3');
    });
});

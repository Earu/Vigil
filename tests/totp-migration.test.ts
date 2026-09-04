import { describe, it, expect } from 'vitest';
import { TotpService } from '../src/services/TotpService';

// Tiny protobuf encoder to build Google Authenticator migration payloads
const varint = (n: number): number[] => {
    const out: number[] = [];
    do {
        let byte = n & 0x7f;
        n = Math.floor(n / 128);
        if (n > 0) byte |= 0x80;
        out.push(byte);
    } while (n > 0);
    return out;
};
const lenField = (field: number, bytes: number[]): number[] =>
    [(field << 3) | 2, ...varint(bytes.length), ...bytes];
const varField = (field: number, value: number): number[] =>
    [field << 3, ...varint(value)];
const str = (s: string): number[] => Array.from(new TextEncoder().encode(s));

interface AccountSpec {
    secret: number[];
    name?: string;
    issuer?: string;
    algorithm?: number;
    digits?: number;
    type?: number;
    counter?: number;
}

const otpParameters = (spec: AccountSpec): number[] => [
    ...lenField(1, spec.secret),
    ...(spec.name ? lenField(2, str(spec.name)) : []),
    ...(spec.issuer ? lenField(3, str(spec.issuer)) : []),
    ...(spec.algorithm != null ? varField(4, spec.algorithm) : []),
    ...(spec.digits != null ? varField(5, spec.digits) : []),
    ...(spec.type != null ? varField(6, spec.type) : []),
    ...(spec.counter != null ? varField(7, spec.counter) : []),
];

const migrationUri = (accounts: AccountSpec[], { escape = true } = {}): string => {
    const payload = [
        ...accounts.flatMap((a) => lenField(1, otpParameters(a))),
        ...varField(2, 1), // version
        ...varField(3, 1), // batch_size
        ...varField(4, 0), // batch_index
    ];
    const b64 = btoa(String.fromCharCode(...payload));
    return `otpauth-migration://offline?data=${escape ? encodeURIComponent(b64) : b64}`;
};

// RFC 6238 test seed: ASCII "12345678901234567890"
const RFC_SEED = Array.from('12345678901234567890', (c) => c.charCodeAt(0));
const RFC_SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('Google Authenticator migration QR', () => {
    it('decodes a multi-account export', () => {
        const accounts = TotpService.parseMigrationUri(migrationUri([
            { secret: RFC_SEED, name: 'alice@example.com', issuer: 'GitHub', algorithm: 1, digits: 1, type: 2 },
            { secret: [1, 2, 3, 4, 5], name: 'bob', issuer: 'AWS', algorithm: 2, digits: 2, type: 2 },
        ]));
        expect(accounts).not.toBeNull();
        expect(accounts!.length).toBe(2);

        expect(accounts![0].issuer).toBe('GitHub');
        expect(accounts![0].name).toBe('alice@example.com');
        expect(accounts![0].config).toEqual({ type: 'totp', secret: RFC_SEED_B32, period: 30, digits: 6, algorithm: 'SHA-1' });

        expect(accounts![1].issuer).toBe('AWS');
        expect(accounts![1].config.digits).toBe(8);
        expect(accounts![1].config.algorithm).toBe('SHA-256');
    });

    it('produces secrets the TOTP generator accepts', async () => {
        const accounts = TotpService.parseMigrationUri(migrationUri([
            { secret: RFC_SEED, name: 'x', type: 2 },
        ]));
        // RFC 6238 vector: T=59s, SHA-1, 8 digits -> 94287082; with 6 digits
        // the code is its last 6 digits
        const code = await TotpService.generateCode(accounts![0].config, 59 * 1000);
        expect(code).toBe('287082');
    });

    it('decodes HOTP accounts with their counter and treats unspecified type as TOTP', async () => {
        const accounts = TotpService.parseMigrationUri(migrationUri([
            { secret: RFC_SEED, name: 'counter-based', type: 1, counter: 7 },
            { secret: [8, 8, 8], name: 'no-type' },
        ]));
        expect(accounts!.length).toBe(2);
        expect(accounts![0].config).toEqual({ type: 'hotp', secret: RFC_SEED_B32, digits: 6, algorithm: 'SHA-1', counter: 7 });
        // RFC 4226 vector for counter 7
        expect(await TotpService.generateCode(accounts![0].config)).toBe('162583');
        expect(accounts![1].config).toMatchObject({ type: 'totp', period: 30 });
    });

    it('reads a missing counter as 0', () => {
        const accounts = TotpService.parseMigrationUri(migrationUri([{ secret: RFC_SEED, name: 'x', type: 1 }]));
        expect(accounts![0].config).toMatchObject({ type: 'hotp', counter: 0 });
    });

    it('accepts a data parameter with unescaped base64', () => {
        // Enough 0xff bytes guarantee '+' and '/' appear in the base64
        const secret = Array.from({ length: 24 }, (_, i) => (i * 61 + 251) & 0xff);
        const uri = migrationUri([{ secret, name: 'raw', type: 2 }], { escape: false });
        const accounts = TotpService.parseMigrationUri(uri);
        expect(accounts).not.toBeNull();
        expect(accounts!.length).toBe(1);
    });

    it('decodes the canonical sample payload', () => {
        // Widely used reference export: secret "Hello!\xde\xad\xbe\xef",
        // label "Example:alice@google.com", issuer "Example", SHA1, 6 digits
        const accounts = TotpService.parseMigrationUri(
            'otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZSABKAEwAg=='
        );
        expect(accounts).not.toBeNull();
        expect(accounts!.length).toBe(1);
        expect(accounts![0].name).toBe('Example:alice@google.com');
        expect(accounts![0].issuer).toBe('Example');
        expect(accounts![0].config).toEqual({
            type: 'totp',
            secret: 'JBSWY3DPEHPK3PXP',
            period: 30,
            digits: 6,
            algorithm: 'SHA-1',
        });
    });

    it('rejects garbage without throwing', () => {
        expect(TotpService.parseMigrationUri('otpauth-migration://offline?data=%%%')).toBeNull();
        expect(TotpService.parseMigrationUri('otpauth-migration://offline?data=bm90IHByb3RvYnVmIGF0IGFsbCEhIQ==')).toBeNull();
        expect(TotpService.parseMigrationUri('otpauth://totp/x?secret=ABCD')).toBeNull();
        expect(TotpService.parseMigrationUri('otpauth-migration://offline?other=1')).toBeNull();
    });
});

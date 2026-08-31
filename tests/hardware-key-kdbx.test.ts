import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createHmac } from 'node:crypto';

// Full credential loop: a database created with a challenge-response callback
// must reload with the same key and reject a different one. The fake below
// stands in for the YubiKey HMAC slot; the driver protocol itself is covered
// by hardware-key.test.ts

const SECRET_A = Buffer.from('a'.repeat(40), 'hex');
const SECRET_B = Buffer.from('b'.repeat(40), 'hex');

let challengeCount = 0;
const hmacResponder = (secret: Buffer) => async (challenge: ArrayBuffer): Promise<ArrayBuffer> => {
    challengeCount++;
    const digest = createHmac('sha1', secret).update(new Uint8Array(challenge)).digest();
    const out = new ArrayBuffer(digest.length);
    new Uint8Array(out).set(digest);
    return out;
};

const credentials = (secret: Buffer) =>
    new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test-pass'), null, hmacResponder(secret));

describe('kdbx challenge-response credentials', () => {
    it('round trips a database and challenges on every save and load', async () => {
        const db = kdbxweb.Kdbx.create(credentials(SECRET_A), 'hw-test');
        // node kdbxweb has no argon2 wired in the test environment
        db.setVersion(3);
        const entry = db.createEntry(db.getDefaultGroup());
        entry.fields.set('Title', 'guarded');

        challengeCount = 0;
        const data = await db.save();
        expect(challengeCount).toBeGreaterThan(0);

        const reloaded = await kdbxweb.Kdbx.load(data, credentials(SECRET_A));
        const titles: string[] = [];
        reloaded.getDefaultGroup().entries.forEach((e) => titles.push(String(e.fields.get('Title'))));
        expect(titles).toContain('guarded');
    });

    it('rejects the right password with the wrong hardware key response', async () => {
        const db = kdbxweb.Kdbx.create(credentials(SECRET_A), 'hw-test');
        db.setVersion(3);
        const data = await db.save();

        await expect(kdbxweb.Kdbx.load(data, credentials(SECRET_B))).rejects.toMatchObject({
            code: kdbxweb.Consts.ErrorCodes.InvalidKey,
        });
    });

    it('rejects a database opened without the challenge-response callback', async () => {
        const db = kdbxweb.Kdbx.create(credentials(SECRET_A), 'hw-test');
        db.setVersion(3);
        const data = await db.save();

        const passwordOnly = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test-pass'));
        await expect(kdbxweb.Kdbx.load(data, passwordOnly)).rejects.toMatchObject({
            code: kdbxweb.Consts.ErrorCodes.InvalidKey,
        });
    });
});

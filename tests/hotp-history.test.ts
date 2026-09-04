import { describe, it, expect } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { TotpService } = await import('../src/services/TotpService');

// Generating a HOTP code advances the counter and saves. With history
// retention trimming the oldest revisions, one snapshot per code would push
// the real edits out, so a counter-only change records no revision

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const makeDb = async (fields: Record<string, string | kdbxweb.ProtectedValue>) => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    const entry = db0.createEntry(db0.getDefaultGroup());
    entry.fields.set('Title', 'Counter');
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
    for (const [key, value] of Object.entries(fields)) entry.fields.set(key, value);
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

const findEntry = (db: kdbxweb.Kdbx) => db.getDefaultGroup().entries.find(e => e.fields.get('Title') === 'Counter')!;

const saveWith = async (kdbxDb: kdbxweb.Kdbx, patch: (entry: any) => any) => {
    const database = Svc.convertKdbxToDatabase(kdbxDb);
    const entry = database.root.entries.find(e => e.title === 'Counter')!;
    const [updated] = Svc.saveEntry(database, patch(entry), database.root, false);
    await Svc.saveDatabase(updated, kdbxDb);
    return await loadSaved(env);
};

describe('hotp counter and history', () => {
    it('records no revision for a counter-only change in an otp URI', async () => {
        const kdbxDb = await makeDb({ otp: kdbxweb.ProtectedValue.fromString(`otpauth://hotp/Counter?secret=${SECRET}&issuer=Ex&counter=0`) });

        let reloaded = await saveWith(kdbxDb, e => ({ ...e, customFields: TotpService.withCounter(e.customFields, 1) }));
        let saved = findEntry(reloaded);
        expect(saved.history).toHaveLength(0);
        expect((saved.fields.get('otp') as kdbxweb.ProtectedValue).getText()).toContain('counter=1');
        expect((saved.fields.get('otp') as kdbxweb.ProtectedValue).getText()).toContain('issuer=Ex');

        reloaded = await saveWith(reloaded, e => ({ ...e, customFields: TotpService.withCounter(e.customFields, 2) }));
        saved = findEntry(reloaded);
        expect(saved.history).toHaveLength(0);
        expect(TotpService.getConfig(Svc.convertKdbxToDatabase(reloaded).root.entries[0].customFields)).toMatchObject({ counter: 2 });
    });

    it('records no revision for a counter-only change in HmacOtp-Counter', async () => {
        const kdbxDb = await makeDb({ 'HmacOtp-Secret-Base32': SECRET, 'HmacOtp-Counter': '3' });
        const reloaded = await saveWith(kdbxDb, e => ({ ...e, customFields: TotpService.withCounter(e.customFields, 4) }));
        const saved = findEntry(reloaded);
        expect(saved.history).toHaveLength(0);
        expect(saved.fields.get('HmacOtp-Counter')).toBe('4');
    });

    it('still records a revision when anything else changed alongside the counter', async () => {
        const kdbxDb = await makeDb({ otp: kdbxweb.ProtectedValue.fromString(`otpauth://hotp/Counter?secret=${SECRET}&counter=0`) });
        const reloaded = await saveWith(kdbxDb, e => ({ ...e, username: 'renamed', customFields: TotpService.withCounter(e.customFields, 1) }));
        const saved = findEntry(reloaded);
        expect(saved.history).toHaveLength(1);
        expect(saved.fields.get('UserName')).toBe('renamed');
    });

    it('still records a revision when a TOTP entry changes', async () => {
        const kdbxDb = await makeDb({ otp: kdbxweb.ProtectedValue.fromString(`otpauth://totp/Counter?secret=${SECRET}`) });
        const reloaded = await saveWith(kdbxDb, e => ({ ...e, username: 'renamed' }));
        expect(findEntry(reloaded).history).toHaveLength(1);
    });
});

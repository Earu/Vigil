import { describe, it, expect, beforeAll } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred, loadSaved, MockEnv } from './helpers';

const env: MockEnv = installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');

describe('custom fields', () => {
    let kdbxDb: kdbxweb.Kdbx;

    beforeAll(async () => {
        const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
        db0.setVersion(3);
        const entry = db0.createEntry(db0.getDefaultGroup());
        entry.fields.set('Title', 'Site');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pw'));
        entry.fields.set('PIN', '1234');
        entry.fields.set('TimeOtp-Secret-Base32', kdbxweb.ProtectedValue.fromString('JBSWY3DP'));
        kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), cred());
    });

    it('converts non-standard fields into the model with protection flags', () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const fields = database.root.entries[0].customFields;
        expect(fields.map(f => f.key)).toEqual(['PIN', 'TimeOtp-Secret-Base32']);
        expect(fields[0].protected).toBe(false);
        expect(Svc.getFieldString(fields[0].value)).toBe('1234');
        expect(fields[1].protected).toBe(true);
        expect(Svc.getFieldString(fields[1].value)).toBe('JBSWY3DP');
    });

    it('survives a save untouched and adds no history revision', async () => {
        await Svc.saveDatabase(Svc.convertKdbxToDatabase(kdbxDb), kdbxDb);
        const reloaded = await loadSaved(env);
        const entry = reloaded.getDefaultGroup().entries[0];
        expect(entry.history).toHaveLength(0);
        expect(entry.fields.get('PIN')).toBe('1234');
        const otp = entry.fields.get('TimeOtp-Secret-Base32');
        expect(otp).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((otp as kdbxweb.ProtectedValue).getText()).toBe('JBSWY3DP');
        kdbxDb = reloaded;
    });

    it('edits a value and records a history revision', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        const edited = {
            ...entry,
            customFields: entry.customFields.map(f => f.key === 'PIN' ? { ...f, value: '9999' } : f),
        };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.fields.get('PIN')).toBe('9999');
        expect(reEntry.history).toHaveLength(1);
        kdbxDb = reloaded;
    });

    it('adds a protected field typed as a string and stores it protected', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        const edited = {
            ...entry,
            customFields: [...entry.customFields, { key: 'ApiKey', value: 'secret-token', protected: true }],
        };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const value = reloaded.getDefaultGroup().entries[0].fields.get('ApiKey');
        expect(value).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((value as kdbxweb.ProtectedValue).getText()).toBe('secret-token');
        kdbxDb = reloaded;
    });

    it('removes a field from the kdbx when deleted in the model', async () => {
        const database = Svc.convertKdbxToDatabase(kdbxDb);
        const entry = database.root.entries[0];
        const edited = {
            ...entry,
            customFields: entry.customFields.filter(f => f.key !== 'PIN'),
        };
        const [updated] = Svc.saveEntry(database, edited, database.root, false);
        await Svc.saveDatabase(updated, kdbxDb);

        const reloaded = await loadSaved(env);
        const reEntry = reloaded.getDefaultGroup().entries[0];
        expect(reEntry.fields.has('PIN')).toBe(false);
        expect(reEntry.fields.has('ApiKey')).toBe(true);
        expect(reEntry.fields.has('TimeOtp-Secret-Base32')).toBe(true);
        // the revision before the delete still carries the field
        const last = reEntry.history[reEntry.history.length - 1];
        expect(last.fields.get('PIN')).toBe('9999');
    });
});

import { describe, it, expect, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { changeMasterPassword } = await import('../src/services/MasterPasswordChange');

// Biometric unlock keeps the master password. After a change it must hold the
// new one, and only once the file accepts it; when that cannot be arranged
// it must hold nothing.
//
// The new password is applied by the save, not before it, so a save that
// succeeds here stands in for that by setting it; one that fails leaves the
// vault on the old password, which is what the real save's revert does

const DB = '/vault.kdbx';

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
};

// A save that lands, doing what performSave does with a pending change
const applies = (db: kdbxweb.Kdbx) => async (rekeyTo: kdbxweb.ProtectedValue) => {
    await db.credentials.setPassword(rekeyTo);
    return true;
};

function bridge(enabled: boolean, enableResult: { success: boolean; error?: string } = { success: true }) {
    const calls: string[] = [];
    return {
        calls,
        hasBiometricsEnabled: vi.fn(async () => { calls.push('has'); return { success: true, enabled }; }),
        enableBiometrics: vi.fn(async () => { calls.push('enable'); return enableResult; }),
        disableBiometrics: vi.fn(async () => { calls.push('disable'); return { success: true }; }),
    };
}

describe('changing the master password', () => {
    it('re-seals biometric unlock to the new password, after the save', async () => {
        const db = await makeDb();
        const b = bridge(true);
        const apply = applies(db);
        const save = vi.fn(async (rekeyTo: kdbxweb.ProtectedValue) => { b.calls.push('save'); return apply(rekeyTo); });

        const outcome = await changeMasterPassword('new-pass', save, b, DB);

        expect(outcome).toEqual({ saved: true, biometrics: 'resealed' });
        expect(b.calls).toEqual(['has', 'save', 'enable']);
        expect(b.enableBiometrics).toHaveBeenCalledWith(DB, 'new-pass');
        expect(await Svc.verifyMasterPassword(db, 'new-pass')).toBe(true);
    });

    it('turns biometric unlock off when the new password cannot be sealed', async () => {
        const db = await makeDb();
        const b = bridge(true, { success: false, error: 'Windows Hello verification failed' });

        const outcome = await changeMasterPassword('new-pass', applies(db), b, DB);

        expect(outcome).toEqual({ saved: true, biometrics: 'off', reason: 'Windows Hello verification failed' });
        expect(b.disableBiometrics).toHaveBeenCalledWith(DB);
    });

    it('turns biometric unlock off when the seal call throws', async () => {
        const db = await makeDb();
        const b = bridge(true);
        b.enableBiometrics.mockRejectedValueOnce(new Error('ipc gone'));

        const outcome = await changeMasterPassword('new-pass', applies(db), b, DB);

        expect(outcome.biometrics).toBe('off');
        expect(b.disableBiometrics).toHaveBeenCalledWith(DB);
    });

    // The file stayed on the old password, so the in-memory key goes back to
    // it: otherwise the next save of anything would re-encrypt under the
    // password the user was just told did not take. The sealed biometric
    // copy still holds the old password, which is now correct again
    it('puts the old password back, and leaves biometric unlock alone, when the save fails', async () => {
        const db = await makeDb();
        const b = bridge(true);

        const outcome = await changeMasterPassword('new-pass', async () => false, b, DB);

        expect(outcome).toEqual({ saved: false, biometrics: 'kept' });
        expect(b.enableBiometrics).not.toHaveBeenCalled();
        expect(b.disableBiometrics).not.toHaveBeenCalled();
        expect(await Svc.verifyMasterPassword(db, 'test')).toBe(true);
        expect(await Svc.verifyMasterPassword(db, 'new-pass')).toBe(false);
        // A second attempt starts from the old password, as the user expects
        expect((await changeMasterPassword('new-pass', applies(db), b, DB)).saved).toBe(true);
        expect(await Svc.verifyMasterPassword(db, 'new-pass')).toBe(true);
    });

    it('a failed save re-encrypts nothing under the new password', async () => {
        const db = await makeDb();
        await changeMasterPassword('new-pass', async () => false, undefined, undefined);
        // What a later save would write opens with the old password only
        const bytes = await db.save();
        await expect(kdbxweb.Kdbx.load(bytes, cred())).resolves.toBeDefined();
        await expect(kdbxweb.Kdbx.load(bytes, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('new-pass')))).rejects.toThrow();
    });

    it('treats a save that throws like one that failed', async () => {
        const db = await makeDb();
        const b = bridge(true);

        const outcome = await changeMasterPassword('new-pass', async () => { throw new Error('disk'); }, b, DB);

        expect(outcome).toEqual({ saved: false, biometrics: 'kept' });
        expect(b.disableBiometrics).not.toHaveBeenCalled();
        expect(await Svc.verifyMasterPassword(db, 'test')).toBe(true);
    });

    it('leaves a vault without biometric unlock alone', async () => {
        const db = await makeDb();
        const b = bridge(false);

        expect(await changeMasterPassword('new-pass', applies(db), b, DB)).toEqual({ saved: true, biometrics: 'not-enabled' });
        expect(b.enableBiometrics).not.toHaveBeenCalled();
        expect(b.disableBiometrics).not.toHaveBeenCalled();
    });

    it('works without a bridge or a path, as for a vault opened from bytes', async () => {
        const db = await makeDb();
        expect(await changeMasterPassword('new-pass', applies(db), undefined, undefined)).toEqual({ saved: true, biometrics: 'not-enabled' });
        expect(await Svc.verifyMasterPassword(db, 'new-pass')).toBe(true);
    });
});

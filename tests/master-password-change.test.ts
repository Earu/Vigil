import { describe, it, expect, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { installMockWindow, cred } from './helpers';

installMockWindow();
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { changeMasterPassword } = await import('../src/services/MasterPasswordChange');

// Biometric unlock keeps the master password. After a change it must hold the
// new one, and only once the file accepts it; when that cannot be arranged
// it must hold nothing

const DB = '/vault.kdbx';

const makeDb = async () => {
    const db0 = kdbxweb.Kdbx.create(cred(), 'Vault');
    db0.setVersion(3);
    return await kdbxweb.Kdbx.load(await db0.save(), cred());
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
        const save = vi.fn(async () => { b.calls.push('save'); return true; });

        const outcome = await changeMasterPassword(db, 'new-pass', save, b, DB);

        expect(outcome).toEqual({ saved: true, biometrics: 'resealed' });
        expect(b.calls).toEqual(['has', 'save', 'enable']);
        expect(b.enableBiometrics).toHaveBeenCalledWith(DB, 'new-pass');
        expect(await Svc.verifyMasterPassword(db, 'new-pass')).toBe(true);
    });

    it('turns biometric unlock off when the new password cannot be sealed', async () => {
        const db = await makeDb();
        const b = bridge(true, { success: false, error: 'Windows Hello verification failed' });

        const outcome = await changeMasterPassword(db, 'new-pass', async () => true, b, DB);

        expect(outcome).toEqual({ saved: true, biometrics: 'off', reason: 'Windows Hello verification failed' });
        expect(b.disableBiometrics).toHaveBeenCalledWith(DB);
    });

    it('turns biometric unlock off when the seal call throws', async () => {
        const db = await makeDb();
        const b = bridge(true);
        b.enableBiometrics.mockRejectedValueOnce(new Error('ipc gone'));

        const outcome = await changeMasterPassword(db, 'new-pass', async () => true, b, DB);

        expect(outcome.biometrics).toBe('off');
        expect(b.disableBiometrics).toHaveBeenCalledWith(DB);
    });

    it('turns biometric unlock off, and never re-seals, when the save fails', async () => {
        const db = await makeDb();
        const b = bridge(true);

        const outcome = await changeMasterPassword(db, 'new-pass', async () => false, b, DB);

        expect(outcome).toEqual({ saved: false, biometrics: 'off', reason: 'the database could not be saved' });
        expect(b.enableBiometrics).not.toHaveBeenCalled();
        expect(b.disableBiometrics).toHaveBeenCalledWith(DB);
    });

    it('treats a save that throws like one that failed', async () => {
        const db = await makeDb();
        const b = bridge(true);

        const outcome = await changeMasterPassword(db, 'new-pass', async () => { throw new Error('disk'); }, b, DB);

        expect(outcome.saved).toBe(false);
        expect(b.disableBiometrics).toHaveBeenCalled();
    });

    it('leaves a vault without biometric unlock alone', async () => {
        const db = await makeDb();
        const b = bridge(false);

        expect(await changeMasterPassword(db, 'new-pass', async () => true, b, DB)).toEqual({ saved: true, biometrics: 'not-enabled' });
        expect(b.enableBiometrics).not.toHaveBeenCalled();
        expect(b.disableBiometrics).not.toHaveBeenCalled();
    });

    it('works without a bridge or a path, as for a vault opened from bytes', async () => {
        const db = await makeDb();
        expect(await changeMasterPassword(db, 'new-pass', async () => true, undefined, undefined)).toEqual({ saved: true, biometrics: 'not-enabled' });
        expect(await Svc.verifyMasterPassword(db, 'new-pass')).toBe(true);
    });
});

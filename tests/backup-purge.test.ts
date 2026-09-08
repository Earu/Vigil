import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMockWindow, MockEnv } from './helpers';

// The copies kept before each save open with the master key the vault had at
// the time, so a key change leaves copies the old one still opens. Deleting
// them is offered, never done: they are also the way back from a change the
// user did not mean to make.
const env: MockEnv = installMockWindow();
const { offerBackupPurge } = await import('../src/services/BackupPurge');
const { KeepassDatabaseService: Svc } = await import('../src/services/KeepassDatabaseService');
const { consentQueue } = await import('../src/services/ConsentQueue');

// Stands in for the dialog App renders off the queue: answers whatever the
// purge asks, and records the question
const answerConfirm = (asked: string[], answer: () => boolean) =>
    consentQueue.subscribe(() => {
        const item = consentQueue.getSnapshot();
        if (item?.kind !== 'confirm') return;
        asked.push((item.payload as { message: string }).message);
        queueMicrotask(() => consentQueue.settle(item.id, answer()));
    });

const asked: string[] = [];
let answer = true;
let purged = 0;

beforeEach(() => {
    asked.length = 0;
    env.toasts.length = 0;
    answer = true;
    purged = 0;
    Svc.setPath('/vault.kdbx', new Uint8Array([1]));
    const electron = (globalThis as any).window.electron;
    electron.getBackupInfo = vi.fn(async () => ({ count: backupCount, totalBytes: 0, newest: null }));
    electron.purgeBackups = vi.fn(async () => { purged++; return { success: true, removed: backupCount }; });
    (globalThis as any).window.dispatchEvent = () => true;
    stop?.();
    stop = answerConfirm(asked, () => answer);
});

let stop: (() => void) | undefined;

let backupCount = 0;

describe('offering to delete stale backups', () => {
    it('says nothing when there are none', async () => {
        backupCount = 0;
        await offerBackupPurge();
        expect(asked).toEqual([]);
        expect(purged).toBe(0);
    });

    it('agrees with a single copy', async () => {
        backupCount = 1;
        await offerBackupPurge();
        expect(asked[0]).toBe('1 backup copy of this database still opens with the old master key. Delete it? This cannot be undone.');
        expect(purged).toBe(1);
    });

    it('agrees with several', async () => {
        backupCount = 3;
        await offerBackupPurge();
        expect(asked[0]).toBe('3 backup copies of this database still open with the old master key. Delete them? This cannot be undone.');
        expect(purged).toBe(1);
    });

    it('deletes nothing when the answer is no', async () => {
        backupCount = 2;
        answer = false;
        await offerBackupPurge();
        expect(asked).toHaveLength(1);
        expect(purged).toBe(0);
    });
});

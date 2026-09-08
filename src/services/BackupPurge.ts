import { KeepassDatabaseService } from './KeepassDatabaseService';
import { confirmDialog } from './Dialogs';

// A backup is a copy of the file as it was before a save, so it keeps the
// credentials the vault had at that moment: after a master key change they
// are the copies the old key still opens. Deleting them is offered rather
// than done, since they are also the only way back if the change went
// somewhere the user did not want.
//
// The re-encryption path deliberately does not call this. Its copies are the
// only ones from before a format upgrade, and their weak parameters cost an
// attacker with the machine less than losing that rollback costs the user;
// the ordinary backup rotation ages them out
export async function offerBackupPurge(): Promise<void> {
    const dbPath = KeepassDatabaseService.getPath();
    if (!dbPath || !window.electron) return;
    let count = 0;
    try {
        count = (await window.electron.getBackupInfo(dbPath)).count;
    } catch {
        return;
    }
    if (count === 0) return;

    const one = count === 1;
    const copies = one
        ? '1 backup copy of this database still opens'
        : `${count} backup copies of this database still open`;
    if (!(await confirmDialog(`${copies} with the old master key. Delete ${one ? 'it' : 'them'}? This cannot be undone.`, 'Delete'))) return;

    const result = await window.electron.purgeBackups(dbPath);
    (window as any).showToast?.(result.success
        ? { message: `Deleted ${result.removed} backup ${result.removed === 1 ? 'copy' : 'copies'}`, type: 'success', duration: 3000 }
        : { message: `Could not delete the backups: ${result.error}`, type: 'error', duration: 5000 });
    window.dispatchEvent(new Event('vigil-backups-changed'));
}

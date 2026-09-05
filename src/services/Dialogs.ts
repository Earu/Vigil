import { consentQueue } from './ConsentQueue';
import type { ConfirmRequest } from '../components/ConfirmDialog';

// The in-app replacement for window.confirm; see ConfirmDialog for why.
// Resolves false on Cancel, Escape, or when the vault locks underneath it
export const confirmDialog = (message: string, confirmLabel?: string): Promise<boolean> =>
    consentQueue.enqueue<ConfirmRequest, boolean>('confirm', 0, { message, confirmLabel }, false);

import type { QuickUnlockMethod } from '../types/electron';

export const QUICK_UNLOCK_NAMES: Record<QuickUnlockMethod, string> = {
    'touch-id': 'Touch ID',
    'windows-hello': 'Windows Hello',
    pin: 'PIN'
};

export const PIN_PATTERN = /^\d{6,32}$/;
export const PIN_RULE = 'A PIN is 6 to 32 digits';

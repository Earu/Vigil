import type { QuickUnlockMethod } from '../types/electron';

export const QUICK_UNLOCK_NAMES: Record<QuickUnlockMethod, string> = {
    'touch-id': 'Touch ID',
    'windows-hello': 'Windows Hello',
    pin: 'PIN'
};

export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 32;

export const isValidPin = (pin: string, minLength: number): boolean =>
    /^\d+$/.test(pin) && pin.length >= minLength && pin.length <= MAX_PIN_LENGTH;

export const pinRule = (minLength: number): string => `A PIN is ${minLength} to ${MAX_PIN_LENGTH} digits`;

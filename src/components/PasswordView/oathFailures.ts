import { OathFailure } from '../../types/electron';

// Why a call to the key did not work, and the one thing the user can do about
// it. Shared so the panel and the entry panel's copy-to-key action say the
// same thing about the same failure: `message` stands alone in a toast, and
// the panel adds `hint` under it
export const OATH_FAILURES: Record<OathFailure, { message: string; hint: string }> = {
    unavailable: {
        message: 'Smart card support is not available',
        hint: 'If you own a YubiKey, it can store one-time password accounts on the key itself, and Vigil can show their codes here. '
            + 'This build could not load its smart card module; on Linux that usually means the pcsclite library is not installed.',
    },
    'no-pcscd': {
        message: 'No smart card service',
        hint: 'The key\'s OATH application is reached over the smart card interface, which needs the pcscd service running.',
    },
    'no-key': {
        message: 'No YubiKey found',
        hint: 'Plug the key in, then refresh.',
    },
    locked: {
        message: 'This YubiKey is password protected',
        hint: 'Enter the OATH password to read its accounts.',
    },
    'wrong-password': {
        message: 'Wrong password',
        hint: 'The key rejected that OATH password.',
    },
    timeout: {
        message: 'The key did not answer in time',
        hint: 'A code that needs a touch was not touched, or the key stopped responding. Try again.',
    },
    'in-use': {
        message: 'The key is busy',
        hint: 'Another app is holding the smart card interface. Close Yubico Authenticator and refresh.',
    },
    'no-space': {
        message: 'The key is full',
        hint: 'A YubiKey holds about 32 accounts. Remove one before adding another.',
    },
    'not-found': {
        message: 'That account is no longer on the key',
        hint: 'Refresh to see what the key holds now.',
    },
    failed: {
        message: 'Could not talk to the key',
        hint: 'The key returned an error.',
    },
};

export const oathFailureMessage = (failure: OathFailure | undefined): string =>
    OATH_FAILURES[failure ?? 'failed'].message;

import { OathFailure } from '../../types/electron';

// Why a call to the key did not work, and the one thing the user can do about
// it. Shared so the panel and the entry panel's copy-to-key action say the
// same thing about the same failure: `message` stands alone in a toast, and
// the panel adds `hint` under it
export const OATH_FAILURES: Record<OathFailure, { message: string; hint: string }> = {
    'ykman-missing': {
        message: 'ykman is not installed',
        hint: 'If you own a YubiKey, it can store one-time password accounts on the key itself, and Vigil can show their codes here. '
            + 'Reading them needs ykman, Yubico\'s own command line tool.',
    },
    'no-pcscd': {
        message: 'No smart card service',
        hint: 'The OATH application is reached over the smart card interface, which needs pcscd running. On Linux: sudo systemctl start pcscd.socket',
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
        message: 'The key stopped responding',
        hint: 'Unplug it and plug it back in, then refresh.',
    },
    'in-use': {
        message: 'The key is busy',
        hint: 'Another app is holding the smart card interface. Close Yubico Authenticator and refresh.',
    },
    failed: {
        message: 'Could not read the key',
        hint: 'ykman reported a failure.',
    },
};

export const oathFailureMessage = (failure: OathFailure | undefined): string =>
    OATH_FAILURES[failure ?? 'failed'].message;

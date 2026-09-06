import fs from 'fs';
import { join } from 'path';

// Windows Hello bindings (passport-desktop), loaded only on Windows. Split
// into its own module like get-keytar so a load failure degrades to
// "biometrics unavailable" and tests can stand in for the native binding.
//
// The pinned binary copy-native-modules.mjs put beside this file is the one
// a packaged build loads (see crypto.ts for the same arrangement); the npm
// wrapper merely re-exports the platform package's binding, and neither
// ships in the archive. Without dist-electron (tests, plain Node) the
// wrapper is used
let Passport: any;
let VerificationResult: any;

try {
    if (process.platform === 'win32') {
        const pinned = join(__dirname, 'passport-desktop.node');
        ({ Passport, VerificationResult } = fs.existsSync(pinned) ? require(pinned) : require('passport-desktop'));
    }
} catch (error) {
    console.error('Failed to load passport-desktop:', error);
}

export { Passport, VerificationResult };

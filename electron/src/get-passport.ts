// Windows Hello bindings (passport-desktop), loaded only on Windows. Split
// into its own module like get-keytar so a load failure degrades to
// "biometrics unavailable" and tests can stand in for the native binding
let Passport: any;
let VerificationResult: any;

try {
    if (process.platform === 'win32') {
        ({ Passport, VerificationResult } = require('passport-desktop'));
    }
} catch (error) {
    console.error('Failed to load passport-desktop:', error);
}

export { Passport, VerificationResult };

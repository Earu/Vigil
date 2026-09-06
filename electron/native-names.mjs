// Names shared between the copy step (copy-native-modules.mjs), the check
// on the packaged app (verify-unpacked-natives.mjs) and the tests. Kept
// apart from copy-native-modules.mjs because that file does its work at
// import time

// The file each third-party native module is copied to in dist-electron:
// fixed names the loaders in electron/src look for (get-keytar.ts,
// crypto.ts, hardware-key.ts, get-passport.ts), so a loader needs no
// platform logic of its own and the packaged app has exactly one place to
// find each
export const OUTPUT_NAMES = {
    keytar: 'keytar.node',
    '@node-rs/argon2': 'argon2.node',
    'node-hid': 'node-hid.node',
    'passport-desktop': 'passport-desktop.node',
};

// Addons compiled from this repository (copy-native-modules.mjs buildAddon);
// not pinned, since a compiled binary is not reproducible, and covered by
// build provenance
export const OWN_ADDONS = ['vigil_touchid.node', 'vigil_pcsc.node'];

// What the copy step shipped and against which pin, for the check that runs
// again on the packaged app. Written inside dist-electron, so it travels in
// the integrity-checked archive as a record a third party can compare the
// unpacked files against
export const MANIFEST_NAME = 'native-manifest.json';

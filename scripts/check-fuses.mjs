// Reads the fuse wire out of a packaged Electron binary and compares it with
// what electron-builder.config.js says it should be. The config is the
// intent; this checks the bytes that ship carry it, since a builder change
// or a mis-targeted build could flip runAsNode back on without a word.
//
//     node scripts/check-fuses.mjs [binary]
//
// The binary defaults to the Linux unpacked output of electron-builder

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
// CommonJS package; its named exports do not survive an ESM import
const require = createRequire(import.meta.url);
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const { FuseState } = require('@electron/fuses/dist/constants');
const config = require(path.resolve('electron-builder.config.js'));

function findBinary(explicit) {
    if (explicit) return explicit;
    const dist = path.resolve('dist');
    const found = fs.existsSync(dist)
        ? fs.readdirSync(dist)
            .filter(name => /^linux(-\w+)?-unpacked$/.test(name))
            .map(name => path.join(dist, name, 'vigil'))
            .filter(file => fs.existsSync(file))
        : [];
    if (found.length === 0) throw new Error('no packaged binary: pass its path, or build with electron-builder first');
    return found[0];
}

// electron-builder config key -> fuse wire option
const KEYS = {
    runAsNode: FuseV1Options.RunAsNode,
    enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
    enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
    enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
    loadBrowserProcessSpecificV8Snapshot: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
};

const binary = findBinary(process.argv[2]);
const wire = await getCurrentFuseWire(binary);
let failed = false;
console.log(`fuses in ${binary}`);
for (const [key, option] of Object.entries(KEYS)) {
    const expected = config.electronFuses[key];
    if (expected === undefined) continue;
    const actual = wire[option] === FuseState.ENABLE ? true : wire[option] === FuseState.DISABLE ? false : String(wire[option]);
    const ok = actual === expected;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${key}: ${actual} (config says ${expected})`);
}
if (failed) {
    console.log('\nfuse check failed: the packaged binary does not carry the configured fuses');
    process.exit(1);
}
console.log('fuse check passed');

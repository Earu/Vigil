// Drives the Linux TPM addon against swtpm, a software TPM, in CI.
//
//   tcp     swtpm listens on localhost:2321 and there is no /dev/tpmrm0: the
//           addon must refuse rather than fall back to it, since any local
//           user can listen on that port
//   device  swtpm behind the kernel's vTPM proxy, so /dev/tpmrm0 is real:
//           seal, unseal, a wrong PIN, and the lockout settings before and
//           after Vigil sets a lockout password
//
// Needs the addon built in electron/native/tpm/build/Release and, for
// device, tpm2-tools.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tpm = require('../electron/native/tpm/index.js');
const mode = process.argv[2];

function check(label, condition, detail) {
    assert.ok(condition, `${label}: ${JSON.stringify(detail)}`);
    console.log(`ok  ${label}`);
}

function tpm2(...args) {
    execFileSync(`tpm2_${args[0]}`, args.slice(1), {
        env: { ...process.env, TPM2TOOLS_TCTI: 'device:/dev/tpmrm0' },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
}

assert.equal(tpm.platform, 'linux', 'the native addon did not load');

if (mode === 'tcp') {
    const probe = tpm.probe();
    check('probe refuses the TCP simulator', !probe.ok, probe);
    const sealed = await tpm.seal('Vigil PIN ci', Buffer.alloc(48, 7), '482915');
    check('seal refuses the TCP simulator', !sealed.ok && sealed.code === 'unavailable', sealed);
    const lockout = await tpm.lockout();
    check('lockout refuses the TCP simulator', !lockout.ok, lockout);
    const setLockout = await tpm.setLockout(Buffer.from('ci-lockout'));
    check('setLockout refuses the TCP simulator', !setLockout.ok && setLockout.code === 'unavailable', setLockout);
} else if (mode === 'device') {
    check('probe reaches /dev/tpmrm0', tpm.probe().ok, tpm.probe());

    const secret = Buffer.alloc(48, 7);
    const sealed = await tpm.seal('Vigil PIN ci', secret, '482915');
    check('seal', sealed.ok, sealed);
    const opened = await tpm.unseal('Vigil PIN ci', '482915', sealed.sealed);
    check('unseal with the right PIN', opened.ok && opened.data.equals(secret), opened.code);
    const refused = await tpm.unseal('Vigil PIN ci', '000000', sealed.sealed);
    check('unseal with a wrong PIN', !refused.ok && refused.code === 'wrong-pin', refused);

    const fresh = await tpm.lockout();
    check('lockout reads a fresh TPM as unprotected', fresh.ok && !fresh.lockoutAuthSet, fresh);

    const limits = { maxTries: 16, recoveryInterval: 3600, lockoutRecovery: 86400 };
    const tooLong = await tpm.setLockout(Buffer.alloc(33, 0x61), limits);
    check('setLockout refuses an oversized password', !tooLong.ok && tooLong.code === 'bad-input', tooLong);

    const withLimits = await tpm.setLockout(Buffer.from('k7qm-2xrp-9dht-w4nb'), limits);
    check('setLockout sets the password and the limits', withLimits.ok, withLimits);
    const limited = await tpm.lockout();
    check('lockout reads the password, the limits and the failure count',
        limited.ok && limited.lockoutAuthSet && limited.maxTries === 16 && limited.recoveryInterval === 3600
            && limited.lockoutRecovery === 86400 && limited.failures === 1,
        limited);
    tpm2('dictionarylockout', '--clear-lockout', '--auth=k7qm-2xrp-9dht-w4nb');
    check('tpm2-tools accept the password Vigil set', true);
    tpm2('changeauth', '-c', 'lockout', '-p', 'k7qm-2xrp-9dht-w4nb');

    const passwordOnly = await tpm.setLockout(Buffer.from('8c5p-9gfw-0tnv-49rh'));
    check('setLockout sets only the password when given no limits', passwordOnly.ok, passwordOnly);
    const kept = await tpm.lockout();
    check('the limits stay as they were',
        kept.ok && kept.lockoutAuthSet && kept.maxTries === 16 && kept.recoveryInterval === 3600 && kept.lockoutRecovery === 86400,
        kept);
    tpm2('dictionarylockout', '--clear-lockout', '--auth=8c5p-9gfw-0tnv-49rh');
    check('tpm2-tools accept the second password', true);

    const again = await tpm.setLockout(Buffer.from('another-password'), limits);
    check('setLockout cannot replace a password it does not hold', !again.ok, again);
} else {
    console.error('usage: node scripts/tpm-integration.mjs tcp|device');
    process.exit(2);
}

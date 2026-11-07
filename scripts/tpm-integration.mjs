// Drives the Linux TPM addon against swtpm, a software TPM, in CI.
//
//   tcp     swtpm listens on localhost:2321 and there is no /dev/tpmrm0: the
//           addon must refuse rather than fall back to it, since any local
//           user can listen on that port
//   device  swtpm behind the kernel's vTPM proxy, so /dev/tpmrm0 is real:
//           seal, unseal, a wrong PIN, and the lockout settings before and
//           after a lockout password is set
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

    tpm2('dictionarylockout', '--setup-parameters', '--max-tries=32', '--recovery-time=7200', '--lockout-recovery-time=86400');
    tpm2('changeauth', '-c', 'lockout', 'ci-lockout');
    const protectedTpm = await tpm.lockout();
    check('lockout reads the password and the limits',
        protectedTpm.ok && protectedTpm.lockoutAuthSet && protectedTpm.maxTries === 32 && protectedTpm.recoveryInterval === 7200,
        protectedTpm);
} else {
    console.error('usage: node scripts/tpm-integration.mjs tcp|device');
    process.exit(2);
}

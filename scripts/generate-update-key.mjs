// Generates the Ed25519 key pair that authenticates update metadata.
//     node scripts/generate-update-key.mjs
//
// The public half goes into UPDATE_PUBLIC_KEY in electron/src/updater.ts and
// ships inside the app. The private half goes into the UPDATE_SIGNING_KEY
// repository secret and nowhere else: the release workflow uses it to sign
// latest*.yml (scripts/sign-update-metadata.mjs), and whoever holds it can
// ship an update to every user. Keep a copy somewhere the repository is not,
// because losing it means every installed build refuses all future updates
// until users reinstall by hand.

import { generateKeyPairSync } from 'crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

console.log('UPDATE_PUBLIC_KEY (paste into electron/src/updater.ts):\n');
console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
console.log('\nUPDATE_SIGNING_KEY (add as a repository secret, then delete this output):\n');
console.log(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim());

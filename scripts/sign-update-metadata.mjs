// Signs every latest*.yml electron-builder wrote, so the app can tell a
// release made by this workflow from one made by whoever got hold of the
// GitHub account. Run after the build, before the artifacts are uploaded:
//     node scripts/sign-update-metadata.mjs dist
//
// Each file gets a sibling <name>.sig holding the base64 Ed25519 signature
// over its exact bytes. The private key arrives in UPDATE_SIGNING_KEY as the
// PKCS8 PEM that scripts/generate-update-key.mjs printed. Its absence is an
// error rather than a warning: a release whose metadata is unsigned would be
// refused by every installed build, and finding that out from the release
// is worse than finding it out here.

import { createPrivateKey, sign } from 'crypto';
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] ?? 'dist';
const pem = process.env.UPDATE_SIGNING_KEY;

if (!pem) {
    console.error('UPDATE_SIGNING_KEY is not set: refusing to produce a release whose update metadata is unsigned.');
    console.error('Generate a key pair with scripts/generate-update-key.mjs and add the private half as a repository secret.');
    process.exit(1);
}

const key = createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ed25519') {
    console.error(`UPDATE_SIGNING_KEY is ${key.asymmetricKeyType}, expected ed25519`);
    process.exit(1);
}

const files = fs.readdirSync(dir).filter(name => /^latest.*\.yml$/.test(name));
if (files.length === 0) {
    console.error(`no update metadata (latest*.yml) in ${dir}`);
    process.exit(1);
}

for (const name of files) {
    const file = path.join(dir, name);
    const signature = sign(null, fs.readFileSync(file), key);
    fs.writeFileSync(`${file}.sig`, `${signature.toString('base64')}\n`);
    console.log(`signed ${name}`);
}

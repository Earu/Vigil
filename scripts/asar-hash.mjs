// Hashes the app.asar electron-builder produced and, given a name, writes
// the hash next to the installers so it ships with the release.
//
// The asar is the part of a build that is reproducible: JavaScript bundles,
// assets, package.json and the production dependency tree, all derived from
// the lockfile with no timestamps or build paths in the archive. The
// installer around it (AppImage, NSIS, DMG) is not, so this is the number
// a third party compares after rebuilding from the same commit.
//
//     node scripts/asar-hash.mjs [dist] [--write <file name>]
//
// Prints "<sha256>  app.asar". With --write, also writes that line to
// dist/<file name>.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const writeAt = argv.indexOf('--write');
const writeName = writeAt === -1 ? null : argv[writeAt + 1];
const positional = argv.filter((arg, i) => !arg.startsWith('--') && (writeAt === -1 || i !== writeAt + 1));
const dist = path.resolve(positional[0] ?? 'dist');

// Linux: linux-unpacked/resources, Windows: win-unpacked/resources,
// macOS: mac-<arch>/Vigil.app/Contents/Resources
function findAsar(root, depth = 0) {
    if (depth > 5 || !fs.existsSync(root)) return [];
    const found = [];
    for (const name of fs.readdirSync(root)) {
        const full = path.join(root, name);
        let stat;
        try {
            stat = fs.statSync(full);
        } catch {
            continue;
        }
        if (stat.isFile() && name === 'app.asar') found.push(full);
        else if (stat.isDirectory() && !name.endsWith('.asar.unpacked')) found.push(...findAsar(full, depth + 1));
    }
    return found;
}

const asars = findAsar(dist);
if (asars.length !== 1) {
    console.error(asars.length === 0
        ? `no app.asar under ${dist}: build with electron-builder first`
        : `several app.asar files under ${dist}:\n  ${asars.join('\n  ')}`);
    process.exit(1);
}

const digest = crypto.createHash('sha256').update(fs.readFileSync(asars[0])).digest('hex');
const line = `${digest}  app.asar\n`;
process.stdout.write(line);
if (writeName) {
    if (!/^[\w.@+-]+$/.test(writeName)) {
        console.error(`refusing to write to ${writeName}`);
        process.exit(1);
    }
    fs.writeFileSync(path.join(dist, writeName), line);
    console.error(`wrote ${path.join(dist, writeName)} (from ${path.relative(dist, asars[0])})`);
}

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { checkNativeModule, UNPINNED_OVERRIDE } from './native-pins.mjs';
import { MANIFEST_NAME, OWN_ADDONS } from './native-names.mjs';

// The pin check on the packaged app, run from electron-builder's afterPack
// hook. copy-native-modules.mjs checks each binary as it copies it, but
// electron-builder runs after that, and until this check nothing looked at
// what it actually packed: the files that end up under app.asar.unpacked
// are the ones the app loads, and the copy step's verdict says nothing about
// them if anything between the two touched dist-electron or node_modules.
//
// Two things are established here. Every binary the copy step recorded in
// its manifest is in the package with the pinned bytes. And no other .node
// file is in the package at all: a native binary that reached the unpacked
// directory some other way (a dependency's build output the file list
// failed to exclude, say) would run with the same privileges and no pin.
//
// Pure apart from reading the files it is given, so the tests can run it
// over a scratch directory with a check of their own. A problem is
// { file, reason }

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function walk(dir, found = []) {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) walk(full, found);
        else if (stat.isFile() && name.endsWith('.node')) found.push(full);
    }
    return found;
}

// unpackedRoot is app.asar.unpacked; the manifest is what the copy step
// wrote. Returns every problem found, or none for a package whose unpacked
// native binaries are exactly the manifest's, byte for byte, plus the
// addons built from this repository
export function auditUnpacked({ unpackedRoot, manifest, check = checkNativeModule, ownAddons = OWN_ADDONS }) {
    const problems = [];
    const nativeDir = path.join(unpackedRoot, 'dist-electron');
    const expected = new Set();
    for (const [fileName, entry] of Object.entries(manifest)) {
        const file = path.join(nativeDir, fileName);
        expected.add(path.resolve(file));
        if (!fs.existsSync(file)) {
            problems.push({ file, reason: `${entry.module} is missing from the package` });
            continue;
        }
        const result = check({ module: entry.module, version: entry.version, target: entry.target, sha256: sha256(file) });
        if (!result.ok) problems.push({ file, reason: result.reason });
    }
    for (const name of ownAddons) expected.add(path.resolve(path.join(nativeDir, name)));
    if (fs.existsSync(unpackedRoot)) {
        for (const file of walk(unpackedRoot)) {
            if (!expected.has(path.resolve(file))) problems.push({ file, reason: 'a native binary the copy step did not ship' });
        }
    }
    return problems;
}

// Where electron-builder put the resources for this platform
export function resourcesDir(appOutDir, electronPlatformName, productFilename) {
    if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
        return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
    }
    return path.join(appOutDir, 'resources');
}

// electron-builder afterPack. Reads the manifest from the build tree rather
// than out of the archive: the two are the same bytes (dist-electron/**
// is packed whole), and the tree is what this build just produced. Fails
// the build on any problem unless the same override the copy step honours
// is set, in which case each problem is a warning
export async function afterPack(context) {
    const manifestFile = path.join(process.cwd(), 'dist-electron', MANIFEST_NAME);
    if (!fs.existsSync(manifestFile)) {
        throw new Error(`${manifestFile} is missing: run electron/copy-native-modules.mjs before electron-builder`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const resources = resourcesDir(context.appOutDir, context.electronPlatformName, context.packager.appInfo.productFilename);
    const unpackedRoot = path.join(resources, 'app.asar.unpacked');
    const problems = auditUnpacked({ unpackedRoot, manifest });
    for (const [fileName, entry] of Object.entries(manifest)) {
        if (!problems.some(problem => problem.file.endsWith(fileName))) {
            console.log(`${entry.module} ${entry.version} in the package matches its pin for ${entry.target}`);
        }
    }
    if (problems.length === 0) return;
    const lines = problems.map(problem => `  ${problem.file}: ${problem.reason}`).join('\n');
    if (process.env[UNPINNED_OVERRIDE] === '1') {
        console.warn(`WARNING: packaged native binaries do not match their pins (${UNPINNED_OVERRIDE}=1):\n${lines}`);
        return;
    }
    throw new Error(`Refusing to package: native binaries in app.asar.unpacked do not match their pins\n${lines}`);
}

import { familySync, GLIBC } from 'detect-libc';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { checkNativeModule, UNPINNED_OVERRIDE } from './native-pins.mjs';

const modulesToCopy = ['keytar', '@node-rs/argon2', 'node-hid'];
if (process.platform === 'win32') {
    modulesToCopy.push('passport-desktop');
}

// Addons that are ours are compiled here rather than downloaded. Node-API, so
// one binary works across Node and every Electron version that supports the
// same NAPI level; only the architecture has to match
const NATIVE_DIR = path.join(process.cwd(), 'electron', 'native');

function buildAddon(name, { fallback }) {
    const dir = path.join(NATIVE_DIR, name);
    const target = `vigil_${name}.node`;
    const output = path.join(dir, 'build', 'Release', target);
    const sources = fs.readdirSync(path.join(dir, 'src'))
        .map(file => fs.statSync(path.join(dir, 'src', file)).mtimeMs);
    const upToDate = fs.existsSync(output)
        && Math.max(...sources) < fs.statSync(output).mtimeMs
        && fs.statSync(path.join(dir, 'binding.gyp')).mtimeMs < fs.statSync(output).mtimeMs;

    try {
        // A full rebuild takes seconds and `npm run electron:dev` runs this on
        // every start, so skip it when nothing the binary is made of changed
        if (!upToDate) {
            execFileSync('npx', ['node-gyp', 'rebuild'], { cwd: dir, stdio: 'inherit' });
        }
    } catch (error) {
        // A missing toolchain must not break the build; the feature then
        // reports itself unavailable at runtime
        console.warn(`Could not build the ${name} addon, ${fallback}:`, error.message);
        return;
    }
    fs.copyFileSync(output, path.join(process.cwd(), 'dist-electron', target));
    console.log(`Copied ${target} to dist-electron`);
}

// Modules whose prebuild file name says nothing about the module
const outputNames = { 'node-hid': 'node-hid.node' };

// Where a module's binary for this host is, which package.json states its
// version, and the target name its pin is filed under (native-pins.mjs)
function locateModule(moduleName) {
    const basePath = path.join(process.cwd(), 'node_modules', moduleName);
    const platform = process.platform;
    const arch = process.arch;

    if (moduleName === '@node-rs/argon2') {
        let variant;
        // Linux has two mainstream libcs for some odd reason
        // Too bad!
        if (platform === 'linux')
            variant = familySync() === GLIBC ? '-gnu' : '-musl';
        else
            variant = platform === 'win32' ? '-msvc' : '';

        const target = `${platform}-${arch}${variant}`;
        const packageDir = path.join(process.cwd(), 'node_modules', '@node-rs', `argon2-${target}`);
        const nativeFile = fs.readdirSync(packageDir).find(file => file.endsWith('.node'));
        return { file: path.join(packageDir, nativeFile), packageDir, target };
    }

    if (moduleName === 'passport-desktop') {
        const variant = platform === 'win32' ? '-msvc' : '';
        const target = `${platform}-${arch}${variant}`;
        const packageDir = path.join(process.cwd(), 'node_modules', `passport-desktop-${target}`);
        const nativeFile = fs.readdirSync(packageDir).find(file => file.endsWith('.node'));
        return { file: path.join(packageDir, nativeFile), packageDir, target };
    }

    // node-hid ships prebuilds per platform; on Linux the hidraw variant is
    // the one the wrapper selects by default
    if (moduleName === 'node-hid') {
        let name;
        let target;
        if (platform === 'linux') {
            const muslSuffix = familySync() === GLIBC ? '' : '-musl';
            target = `linux-${arch}${muslSuffix}`;
            name = `HID_hidraw-${target}`;
        } else {
            target = `${platform}-${arch}`;
            name = `HID-${target}`;
        }
        return { file: path.join(basePath, 'prebuilds', name, 'node-napi-v4.node'), packageDir: basePath, target };
    }

    // keytar: whatever prebuild-install fetched (or node-gyp built)
    const buildPath = path.join(basePath, 'build', 'Release');
    const nativeFile = fs.readdirSync(buildPath).find(file => file.endsWith('.node'));
    return { file: path.join(buildPath, nativeFile), packageDir: basePath, target: `${platform}-${arch}` };
}

// Create the destination directory if it doesn't exist
const destDir = path.join(process.cwd(), 'dist-electron')
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

// Every binary that ships unpacked is checked against its pin right before
// it is copied: the last moment anything could still have swapped it. See
// electron/native-pins.mjs for why the lockfile is not enough
function verifyPinned(moduleName, { file, packageDir, target }) {
    const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const result = checkNativeModule({ module: moduleName, version, target, sha256 });
    if (result.ok) {
        console.log(`${moduleName} ${version} matches its pin for ${target}`);
        return;
    }
    if (process.env[UNPINNED_OVERRIDE] === '1') {
        console.warn(`WARNING: shipping an unpinned ${moduleName} binary (${UNPINNED_OVERRIDE}=1): ${result.reason}`);
        return;
    }
    console.error(`Refusing to ship ${moduleName}: ${result.reason}`);
    console.error(`For a local build from source, set ${UNPINNED_OVERRIDE}=1; a release must match the pin`);
    process.exit(1);
}

// Copy node native modules
for (const moduleName of modulesToCopy) {
    try {
        const located = locateModule(moduleName);
        verifyPinned(moduleName, located);
        const modulePath = located.file;
        const fileName = outputNames[moduleName] ?? path.basename(modulePath);
        const targetPath = path.join(process.cwd(), 'dist-electron', fileName);
        fs.copyFileSync(modulePath, targetPath);
        console.log(`Copied ${fileName} to dist-electron`);
    } catch (error) {
        console.error(`Failed to copy ${moduleName}:`, error);
        process.exit(1);
    }
}

// Touch ID is macOS only: on other platforms biometrics never reaches it, and
// building a stub that always reports "unimplemented" buys nothing
if (process.platform === 'darwin') {
    buildAddon('touchid', { fallback: 'biometric unlock will fall back' });
}
// PC/SC is the YubiKey OATH transport on every platform. Linux needs the
// pcsclite headers (see electron/native/pcsc/README.md)
buildAddon('pcsc', { fallback: 'YubiKey OATH codes will be unavailable' });

import { familySync, GLIBC } from 'detect-libc';
import fs from 'fs';
import path from 'path';

const modulesToCopy = ['keytar', '@node-rs/argon2', 'node-hid'];
if (process.platform === 'win32') {
    modulesToCopy.push('passport-desktop');
}

// Modules whose prebuild file name says nothing about the module
const outputNames = { 'node-hid': 'node-hid.node' };

// Get the platform-specific path for node native modules
function getModulePath(moduleName) {
    const basePath = path.join(process.cwd(), 'node_modules', moduleName);

    // Special handling for @node-rs/argon2
    if (moduleName === '@node-rs/argon2') {
        const platform = process.platform;
        const arch = process.arch;
        let variant;

        // Linux has two mainstream libcs for some odd reason
        // Too bad!
        if (platform === "linux")
            variant = familySync() === GLIBC ? "-gnu" : "-musl";
        else
            variant = platform === 'win32' ? '-msvc' : '';

        const nativeModuleName = `argon2-${platform}-${arch}${variant}`;
        const nativeModulePath = path.join(process.cwd(), 'node_modules', '@node-rs', nativeModuleName);
        const files = fs.readdirSync(nativeModulePath);
        const nativeFile = files.find(file => file.endsWith('.node'));
        return path.join(nativeModulePath, nativeFile);
    }

    // Special handling for passport-desktop
    if (moduleName === 'passport-desktop') {
        const platform = process.platform;
        const arch = process.arch;
        const variant = platform === 'win32' ? '-msvc' : '';
        const nativeModuleName = `passport-desktop-${platform}-${arch}${variant}`;
        const nativeModulePath = path.join(process.cwd(), 'node_modules', nativeModuleName);
        const files = fs.readdirSync(nativeModulePath);
        const nativeFile = files.find(file => file.endsWith('.node'));
        return path.join(nativeModulePath, nativeFile);
    }

    // node-hid ships prebuilds per platform; on Linux the hidraw variant is
    // the one the wrapper selects by default
    if (moduleName === 'node-hid') {
        const platform = process.platform;
        const arch = process.arch;
        let name;
        if (platform === 'linux') {
            const muslSuffix = familySync() === GLIBC ? '' : '-musl';
            name = `HID_hidraw-linux-${arch}${muslSuffix}`;
        } else if (platform === 'win32') {
            name = `HID-win32-${arch}`;
        } else {
            name = `HID-darwin-${arch}`;
        }
        return path.join(basePath, 'prebuilds', name, 'node-napi-v4.node');
    }

    // Default handling for other modules
    const buildPath = path.join(basePath, 'build', 'Release');
    const files = fs.readdirSync(buildPath);
    const nativeFile = files.find(file => file.endsWith('.node'));
    return path.join(buildPath, nativeFile);
}

// Create the destination directory if it doesn't exist
const destDir = path.join(process.cwd(), 'dist-electron')
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

// Copy node native modules
for (const moduleName of modulesToCopy) {
    try {
        const modulePath = getModulePath(moduleName);
        const fileName = outputNames[moduleName] ?? path.basename(modulePath);
        const targetPath = path.join(process.cwd(), 'dist-electron', fileName);
        fs.copyFileSync(modulePath, targetPath);
        console.log(`Copied ${fileName} to dist-electron`);
    } catch (error) {
        console.error(`Failed to copy ${moduleName}:`, error);
        process.exit(1);
    }
}
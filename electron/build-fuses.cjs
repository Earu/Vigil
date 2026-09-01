const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');

// electron-builder's build.electronFuses is one setting for every platform, and
// runAsNode cannot be one setting: macOS and Linux reach the native messaging
// proxy through a --browser-proxy flag and need it off, Windows still needs
// ELECTRON_RUN_AS_NODE because Electron corrupts stdout there before any app
// code runs (see windowsWrapperScript). So the fuse is flipped here instead,
// per packed platform.
//
// Off matters most on macOS: with it on, any local process can run arbitrary
// JavaScript inside the signed bundle and inherit whatever the user granted
// Vigil, which for anyone who has used the QR scanner includes screen
// recording, alongside the keychain access group the Touch ID item lives in.
// Which binary to flip, or null for a platform that keeps the fuse as packed.
// Exported so the choice can be tested without a real packed app
function executableFor(platform, appOutDir, productFilename) {
    switch (platform) {
        case 'darwin':
            return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
        case 'linux':
            return path.join(appOutDir, productFilename.toLowerCase());
        default:
            // Windows included: it still needs ELECTRON_RUN_AS_NODE
            return null;
    }
}

exports.executableFor = executableFor;

exports.default = async function afterPack(context) {
    const platform = context.electronPlatformName;
    const executable = executableFor(platform, context.appOutDir, context.packager.appInfo.productFilename);
    if (!executable) return;

    await flipFuses(executable, {
        version: FuseVersion.V1,
        // Flipping a fuse rewrites the binary and invalidates an ad-hoc
        // signature, so it has to be reapplied
        resetAdHocDarwinSignature: platform === 'darwin',
        [FuseV1Options.RunAsNode]: false,
    });
    console.log(`  • runAsNode fuse disabled for ${platform}`);
};

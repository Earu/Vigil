// electron-builder configuration. This lives here rather than in
// package.json > build because one value has to be computed: the runAsNode
// fuse differs per platform, and the build field is static JSON.
//
// Each platform is built on its own runner (cross building is not supported,
// see .github/workflows/build.yml), so the target is the host unless the
// invocation names one.
// Matched by regex rather than a literal list: electron-builder's yargs CLI
// accepts every alias with either dash count and with an inline value
// ("--win=nsis"), and an unrecognised spelling reads as "no platform named"
// and falls through to the host, so building Windows from Linux would ship
// a Windows build with runAsNode off and no working browser integration,
// silently
const path = require('path');
const { pathToFileURL } = require('url');

const WINDOWS_FLAG = /^--?(w|win|windows)(=.*)?$/;
const PLATFORM_FLAG = /^--?(w|win|windows|m|mac|macos|l|linux)(=.*)?$/;

function targetsWindows() {
    const explicit = process.argv.filter((arg) => PLATFORM_FLAG.test(arg));
    if (explicit.length > 0) {
        return explicit.some((arg) => WINDOWS_FLAG.test(arg));
    }
    return process.platform === 'win32';
}

module.exports = {
    "appId": "earu.vigil.app",
    "productName": "Vigil",
    "directories": {
        "output": "dist",
        "buildResources": "build"
    },
    "files": [
        "dist/**/*",
        "dist-electron/**/*",
        "package.json",
        // Every native module the app uses is loaded from dist-electron,
        // where copy-native-modules.mjs put the copy it checked against
        // electron/native-pins.mjs. The npm packages behind them stay out
        // of the archive entirely: their binaries would otherwise ship
        // unpacked beside the pinned ones with no check on them, and their
        // JavaScript wrappers exist only to locate those binaries. With the
        // packages absent, the loaders' fallback to the package name cannot
        // resolve in a packaged build, so the pinned copy is the only one
        // that can run
        "!node_modules/keytar/**",
        "!node_modules/node-hid/**",
        "!node_modules/@node-rs/**",
        "!node_modules/passport-desktop/**",
        "!node_modules/passport-desktop-*/**"
    ],
    // Off: the prebuilt binaries are chosen, checked and copied by
    // copy-native-modules.mjs, and nothing in the archive is compiled. The
    // rebuild would run every dependency's install script again after that
    // check, with write access to node_modules, and its compiled output
    // carried the build path, which made the archive differ between
    // checkouts
    "npmRebuild": false,
    "asar": true,
    "asarUnpack": [
        "**/*.node"
    ],
    // The pin check again, on what was actually packed: every .node under
    // app.asar.unpacked must be a pinned copy or an addon from this
    // repository (electron/verify-unpacked-natives.mjs)
    "afterPack": async (context) => {
        const { afterPack } = await import(pathToFileURL(path.join(__dirname, 'electron', 'verify-unpacked-natives.mjs')).href);
        await afterPack(context);
    },
    "extraMetadata": {
        "main": "dist-electron/main.js"
    },
    "publish": {
        "provider": "github",
        "owner": "Earu",
        "repo": "Vigil"
    },
    "mac": {
        "target": [
            "dmg",
            "zip"
        ],
        "icon": "build/icons/icon.icns",
        "artifactName": "vigil-macos-${arch}-v${version}.${ext}",
        "hardenedRuntime": true,
        "entitlements": "build/entitlements.mac.plist",
        "entitlementsInherit": "build/entitlements.mac.inherit.plist",
        "provisioningProfile": "build/vigil.provisionprofile",
        "notarize": true
    },
    "linux": {
        "target": "AppImage",
        "icon": "build/icons/icon.png",
        "artifactName": "vigil-linux-${arch}-v${version}.${ext}",
        "executableArgs": [
            "--ozone-platform-hint=auto"
        ]
    },
    "win": {
        "target": "nsis",
        "icon": "build/icons/icon.ico",
        "artifactName": "vigil-windows-${arch}-v${version}.${ext}"
    },
    "fileAssociations": [
        {
            "ext": "kdbx",
            "name": "KeePass Database",
            "description": "KeePass Password Database",
            "role": "Editor",
            "icon": "build/icons/icon"
        }
    ],
    "electronFuses": {
        // Windows reaches the native messaging proxy through
        // ELECTRON_RUN_AS_NODE, because Electron writes a stray CRLF to stdout
        // there before any application code runs (electron/electron#12578) and
        // stdout is the protocol stream. macOS and Linux use a --browser-proxy
        // flag instead and can have this off, which stops a local process
        // running arbitrary JavaScript inside the signed bundle and inheriting
        // what the user granted Vigil: screen recording for the QR scanner,
        // and the keychain access group the Touch ID item lives in.
        //
        // Do not move this back into package.json. It has to be computed, and
        // an afterPack hook cannot do it: electron-builder applies this block
        // after afterPack runs and would flip the fuse straight back.
        "runAsNode": targetsWindows(),
        "enableCookieEncryption": true,
        "enableNodeOptionsEnvironmentVariable": false,
        "enableNodeCliInspectArguments": false,
        "enableEmbeddedAsarIntegrityValidation": true,
        "onlyLoadAppFromAsar": true,
        "loadBrowserProcessSpecificV8Snapshot": false,
        // The renderer loads from its own scheme (electron/src/app-protocol.ts),
        // so file:// pages need no storage or fetch privileges. Settings
        // written by 1.5.x sat in the file:// origin and are not carried
        // over: theme, toggles, remembered key file and hardware key
        // choices reset once
        "grantFileProtocolExtraPrivileges": false
    }
};

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
        "package.json"
    ],
    "asar": true,
    "asarUnpack": [
        "**/*.node"
    ],
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
        "grantFileProtocolExtraPrivileges": true
    }
};

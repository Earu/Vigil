// SHA-256 pins for every native binary that ships outside app.asar.
//
// The lockfile checks each npm tarball as it is downloaded; nothing checks
// the bytes again between then and packaging, and any dependency's install
// script runs in between with write access to node_modules. keytar is worse
// off still: its install script fetches keytar.node from the GitHub releases
// of atom/node-keytar (an archived project) after the lockfile check, with no
// hash of its own. And because these files are asar-unpacked, the
// reproducible app.asar digest never covers them.
//
// So copy-native-modules.mjs hashes each binary just before it is copied
// and refuses one that does not match the digest here. The digests were
// taken once from the published artifacts: the npm registry tarballs for
// @node-rs/argon2, node-hid and passport-desktop, the v7.9.0 release
// tarballs for keytar. A release's resources/app.asar.unpacked/dist-electron
// can be checked against this file. Bumping a module means re-taking its
// digests; the version check makes a forgotten update fail the build.
//
// Keys are the target names copy-native-modules.mjs derives from
// process.platform, process.arch and, on Linux, the libc. The release
// workflow builds linux-x64, linux-arm64, darwin-arm64 and win32-x64; the
// rest are here for local builds on those hosts.
//
// The Touch ID addon is compiled from this repository and is not pinned: a
// compiled binary is not reproducible, and build provenance covers it
export const NATIVE_PINS = {
    keytar: {
        version: '7.9.0',
        sha256: {
            'linux-x64': '0700016bcd761cbe02d275f2046c7cc42f39f730a50d66e3d3307aa9d413373a',
            'linux-arm64': '6b63b86160c97cc7f902f3feb0d670edadb06dfb4ec878870f9e5b6035780f68',
            'darwin-x64': '62a94162e3108f55f287764ebcdec0c735988487b79f45da4172826f0decbc96',
            'darwin-arm64': '6c32c41c0e5a9e546616607b0383eada5bb646d0164324f20baab59d5b7963fa',
            'win32-x64': '90e35de89ab5e5f9290e4ff1bbadcf221a82b2aa0d9b922187dc980adff3c831',
        },
    },
    '@node-rs/argon2': {
        version: '2.0.2',
        sha256: {
            'linux-x64-gnu': 'd63ed9772bfd7efe5407dd3748ad3429fd84add70f87e6d342a96d1daa082349',
            'linux-x64-musl': '3011eb4fb811c5d6cb2729780dddd72b68a85668e6e7763ad3b288ce283545d2',
            'linux-arm64-gnu': '9e31c8b1c1b1ce6212e9c84366a63f9529f5dbc659447705442c357e9eddb06e',
            'linux-arm64-musl': '1074204a76601142e2c9239a8e6ee7ccf7e55903c2ab963912cf4aea84db1348',
            'darwin-x64': '8f85d2111e9061eb508baffc8b6323e9123c93711017ad3229dd409cd6da0491',
            'darwin-arm64': 'bcf95b194800d2447b434fddc5192b0e6d49c142766222836f929b5659738ce3',
            'win32-x64-msvc': 'cab1684df9e70d27e329a16f9caeb75e0b07e24e5da95962047be576f865046f',
        },
    },
    'node-hid': {
        version: '3.4.0',
        sha256: {
            'linux-x64': '5b50d9229ca6ebc78eba1dd9a8c73de18035addf041dbc5a1323cb904dd838c4',
            'linux-x64-musl': 'e085de9cac2ec6c60310656ddf339342511b6ef57ab3ce47ed6faf553a468c03',
            'linux-arm64': 'b0e734bfcca7a2f6ce8e9543a2d39836ff61d3dadf17de5ae5a4387118457b58',
            'darwin-x64': 'c9c28d8db81d8f9d63a43fdfb91db5c472b8106ff34f663bd3131f6ced1e14bc',
            'darwin-arm64': 'fe82d0604b43c4b315552b872fc8b1fffef707cbf1fc1872a2ec7771dd528aec',
            'win32-x64': 'b8501067ca825b48b13a69523b2b8e7e65583a458618521e79135abcaa48d2a4',
        },
    },
    'passport-desktop': {
        version: '0.1.2',
        sha256: {
            'win32-x64-msvc': '207e45135339b19a698f751394fa17d64958ca36bf7b5ea1d4033a6c763e674a',
        },
    },
};

// The only way past a mismatch, for a local build on a host with no
// prebuilt (a module then compiles from source). Never set in CI; the
// hardening invariants check that
export const UNPINNED_OVERRIDE = 'VIGIL_ALLOW_UNPINNED_NATIVE';

export function checkNativeModule({ module, version, target, sha256 }) {
    const pin = NATIVE_PINS[module];
    if (!pin) return { ok: false, reason: `${module} has no pin in electron/native-pins.mjs` };
    if (version !== pin.version) {
        return { ok: false, reason: `${module} ${version} is installed, the pin is for ${pin.version}: update electron/native-pins.mjs from the new release` };
    }
    const expected = pin.sha256[target];
    if (!expected) return { ok: false, reason: `no ${module} pin for ${target}` };
    if (sha256 !== expected) {
        return { ok: false, reason: `${module} binary for ${target} has sha256 ${sha256}, the pin says ${expected}` };
    }
    return { ok: true };
}

# Touch ID keychain addon

Stores a random 32-byte wrapping key as a keychain item gated by
`SecAccessControl(BiometryCurrentSet OR DevicePasscode)`. Reading it makes
macOS run the biometric check before releasing the bytes, so the sealed master
password is not openable by anything that just reads the disk. macOS
counterpart to the Windows Hello path in `biometrics.ts`, modeled on
KeePassXC's `src/quickunlock/TouchID.mm`.

Needs a build signed with entitlements authorized by a provisioning profile
(Apple TN3137). Unsigned builds get `errSecMissingEntitlement` (-34018) and
fall back to the prompt-only scheme; that covers forks, PRs and
`npm run electron:dev`. A certificate without a profile does not work: the
process is SIGKILLed at launch. `LARightStore` is backed by the same keychain
and fails the same way.

## Files

- `src/touchid_mac.mm`: `isAvailable` (sync), async `setSecret`, `getSecret`
  (prompts), `deleteSecret`, `hasSecret`. Raw `OSStatus` out, no logic.
- `src/touchid_stub.cc`: same surface elsewhere, always `errSecUnimplemented`.
- `index.js`: loader and the pure status mappings (`tests/touchid-loader.test.ts`).

Built by `electron/copy-native-modules.mjs` on darwin. Node-API, so one binary
serves any Electron at the same NAPI level, but the architecture must match.
By hand: `npx node-gyp rebuild` from this directory. Not from the repo root,
`rebuild` starts with `rm -rf build`.

## Storage

`biometrics.ts` seals the password as a `v3:` blob in keytar (base64 of IV, GCM
tag, ciphertext) under `HKDF-SHA256(key, "vigil-biometric-v3")`. Legacy blobs
upgrade to `v3:` on first successful unlock.

`BiometryCurrentSet` means macOS destroys the item when enrolled fingerprints
change. That arrives as `not-found`; the app drops the blob and asks the user
to enable unlock again.

## Signing

`build/entitlements.mac.plist` covers the main app. `entitlements.mac.inherit.plist`
covers the helpers and **must stay separate**: pointing `entitlementsInherit` at
the main plist gives each helper an application-identifier matching neither its
bundle id nor any profile, so the kernel kills them and the app dies with
`GPU process isn't usable. Goodbye.` The main process verifies fine throughout,
so it reads as a windowing bug.

`build/vigil.provisionprofile` is the Developer ID direct-distribution profile,
valid to 2044. It is **not committed**, since it embeds the team name; keep a
local copy at that path, and CI restores it from `MAC_PROVISION_PROFILE`
(base64). Regenerate by archiving in Xcode and exporting with
`method: developer-id`; `xcodebuild build` only mints development profiles.

CI also needs `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` for the certificate, and
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` to notarize (or
`APPLE_KEYCHAIN_PROFILE` locally). All optional: with none of them the build is
unsigned. With a certificate but no profile it fails, which is intended, since
signing these entitlements without a profile yields an app whose helpers are
killed at launch.

`build.appId` is `earu.vigil.app` because `com.vigil.app` belongs to another
Apple team. Keychain items are keyed to the signing identity, so users
re-enable biometric unlock and re-grant file access once.

## Verifying a build

```
codesign --verify --deep --strict Vigil.app
xcrun stapler validate Vigil.app            # the app, never the DMG
spctl --assess --type execute -vv Vigil.app # source=Notarized Developer ID
grep zip dist/latest-mac.yml                # or macOS auto-update cannot work
```

Stapling the DMG afterwards rewrites it and invalidates the `sha512` in
`latest-mac.yml`. Launch the app too: `codesign --verify` passed throughout the
helper-entitlement bug above.

# Touch ID keychain addon (dormant)

Real biometric protection for macOS biometric unlock: a random key stored as a
data protection keychain item gated by `SecAccessControl` (Touch ID, or device
passcode as fallback). Reading the item makes macOS run the biometric check and
only then release the bytes. Modeled on KeePassXC's `src/quickunlock/TouchID.mm`.

**This module is not built or wired into the app yet.** Apple only allows
biometry-gated keychain items in the data protection keychain, and that requires
entitlements (`com.apple.application-identifier`, `keychain-access-groups`)
authorized by a provisioning profile, which requires a paid Apple Developer
account and a signed build (Apple TN3137). Vigil's mac build is currently
unsigned. Until that changes, every call would fail with
`errSecMissingEntitlement (-34018)` and the JS layer reports `missing-entitlement`.

## Files

- `src/touchid_mac.mm`: the addon (macOS). Three async ops: `setSecret`,
  `getSecret` (this one shows the Touch ID prompt), `deleteSecret`. Raw
  `OSStatus` out, no logic.
- `src/touchid_stub.cc`: same surface for other platforms, always reports
  `errSecUnimplemented (-4)`. Lets the gyp/napi wiring compile everywhere.
- `index.js`: loader plus `interpret()`, the status-to-outcome mapping
  (unit tested in `tests/touchid-loader.test.ts`).

## Activation checklist

1. Join the Apple Developer Program. Create a Developer ID Application
   certificate and a Developer ID provisioning profile for `com.vigil.app`
   carrying the application-identifier entitlement.
2. Rename `build/entitlements.mac.plist.template` to
   `build/entitlements.mac.plist` and replace `TEAMID` with the real team ID.
   Keep the Electron hardened-runtime keys that are already in the template.
3. `package.json` > `build.mac`: add
   `"hardenedRuntime": true`, `"entitlements": "build/entitlements.mac.plist"`,
   `"entitlementsInherit": "build/entitlements.mac.plist"`,
   `"provisioningProfile": "build/vigil.provisionprofile"`, and notarization
   (`"notarize": true` plus `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` in CI).
3b. Caveat from `electron/src/browser-integration.ts` (wrapperScript): the
   browser proxy runs the app binary with `ELECTRON_RUN_AS_NODE`. Hardened
   runtime strips DYLD/ELECTRON env vars unless the entitlements keep
   `com.apple.security.cs.allow-dyld-environment-variables` (in the template)
   and the RunAsNode Electron fuse stays enabled. Test browser integration
   after signing, before release.
4. CI (`.github/workflows/*.yml`): for the macOS jobs, remove
   `CSC_IDENTITY_AUTO_DISCOVERY: false`, add `CSC_LINK` / `CSC_KEY_PASSWORD`
   secrets with the exported cert.
5. Build the addon on macOS: `cd electron/native/touchid && npx node-gyp rebuild`
   (node-addon-api is already a devDependency, deployment target 11.0). Wire
   the build into `electron:build` for darwin and copy
   `build/Release/vigil_touchid.node` next to the other native modules in
   `electron/copy-native-modules.mjs`.
6. Wire `electron/src/biometrics.ts` (darwin): on enable, generate a random
   32-byte key, `setSecret(dbPath, key)`, seal the master password with
   AES-256-GCM under it (new `v3:` blob in keytar, same pattern as the Windows
   `v2:` path in `biometrics-crypto.ts`); on unlock, `getSecret` (Touch ID
   prompt) and open the blob. `missing-entitlement` or `unavailable` fall back
   to the current Touch ID gate. Drop the legacy hardware-id scheme like the
   Windows migration did.
7. Verify on a real Mac: enable, lock, unlock (prompt must appear on read),
   cancel path, and that an unsigned dev build cleanly falls back.

## Why the native surface is minimal

The `.mm` cannot be compiled or tested from the Linux dev box, so it contains
as little logic as possible: keychain calls and status codes. Everything with
branching lives in `index.js` and is unit tested. The stub compiles on Linux,
which validates the binding/gyp wiring ahead of time.

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
- `src/touchid_parse.h`: the wipe key material goes through, and the decision
  about what can name a keychain item. Reachable without macOS, entitlements
  or a prompt, so `fuzz/` can drive it.
- `src/touchid_stub.cc`: same surface elsewhere, always `errSecUnimplemented`.
- `index.js`: loader and the pure status mappings (`tests/touchid-loader.test.ts`).
- `fuzz/`: the libFuzzer target and its seed corpus.

Built by `electron/copy-native-modules.mjs` on darwin. Node-API, so one binary
serves any Electron at the same NAPI level, but the architecture must match.
By hand: `npx node-gyp rebuild` from this directory. Not from the repo root,
`rebuild` starts with `rm -rf build`.

## Fuzzing

This addon parses no lengths: it is handed an account name, a prompt and a
buffer, passes them to the Security framework, and copies back whatever
`NSData` the OS returns. So there is less to fuzz here than in the PC/SC
addon, and `fuzz/touchid_fuzz.cc` covers the two things that are decisions
rather than pass-through:

- `Scrub`, which has to reach every byte of key material and no byte past it.
  Under AddressSanitizer a wipe that runs off the end is a report rather than
  a silent corruption of whatever follows.
- `ToNSString`, which decides what can name a keychain item. It returns nil
  for bytes `NSString` will not take, and for a name with a NUL in it, and
  every caller refuses the operation. It used to substitute `@""`, which
  meant two names that both failed to convert became the same name and one
  database's key could be read under another's. The NUL rule came out of the
  first macOS fuzz run: `NSString` accepts an embedded NUL. In the Security
  framework's source the legacy keychain then reads string attributes with
  `strlen` (`CloneDataByType` in `libsecurity_keychain/lib/SecItem.cpp`), so
  there the name would end at the NUL. The data protection keychain this
  addon asks for does not go through that code: the query is DER-encoded
  with an explicit length (`der_encode_string`) and securityd stores the
  full string (`copyString`, `copyData` in `keychain/securityd/SecDbItem.c`).
  The name is refused anyway, so the guarantee does not rest on the flag.

`npm run test:fuzz:native -- --target touchid`, or without the flag for both
addons. Only the wipe is covered off macOS: `ToNSString` needs Foundation, so
the security workflow runs the target on a macOS runner as well as Linux.
Nothing in it touches the keychain, so no entitlement, enrolled finger or
prompt is involved.

Apple's clang ships the sanitizers but not libFuzzer, so on macOS the runner
picks a Homebrew LLVM if one is installed (`brew install llvm`; the GitHub
runner images ship one) and fuzzes with that. With Apple's clang alone it
replays the corpus through the target once under the sanitizers instead: a
regression check, not a search. Each instrumentation is probed by building
and running a no-op target before it is used, and the run prints the one it
settled on: a Homebrew LLVM older than the OS can build an AddressSanitizer
binary that never gets past its own startup, in which case the run carries
on without it and says so.

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

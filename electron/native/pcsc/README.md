# PC/SC transport addon

The smallest bridge to the OS smart card API that the YubiKey OATH driver
needs: list readers, connect, transmit an APDU, begin/end a transaction,
disconnect. It knows nothing about YubiKeys or OATH; that protocol lives in
`electron/src/yubikey-oath.ts`, in TypeScript, where it is tested against
recorded card responses.

C++ rather than a binding crate because PC/SC is a C API the OS already ships:
`winscard.h` on Windows, the PCSC framework on macOS, pcsclite on Linux. There
is nothing to vendor and nothing third-party to audit beyond `node-addon-api`,
which the Touch ID addon already relies on.

## Files

- `src/pcsc_addon.cc`: six functions, each one PC/SC call on a worker thread,
  resolving `{ rv, ... }` with the raw return code. No interpretation.
- `src/pcsc_parse.h`: what the addon decides about the lengths and bytes the
  driver reports. Header-only and free of `napi.h`, so the fuzz target can
  compile it alone.
- `index.js`: loader, return-code names, the `Card` wrapper that refuses
  overlapping calls on one handle. Pure parts covered by
  `tests/pcsc-loader.test.ts`.
- `fuzz/`: the libFuzzer target and its seed corpus.

## Build

Built by `electron/copy-native-modules.mjs` on every platform. By hand:
`npx node-gyp rebuild` from this directory. Node-API, so one binary serves any
Electron at the same NAPI level; the architecture must match.

Linux needs `pkgconf` and the pcsclite development package (`pcsclite` on
Arch, `libpcsclite-dev` on Debian, `pcsc-lite-devel` on Fedora). macOS and
Windows link system frameworks.

## Fuzzing

Everything this addon reads comes from outside the process: reader names are
whatever the driver wrote into the multi-string, and the response length is
whatever `SCardTransmit` reported. It is C++, so a length that disagrees with
the bytes behind it is a read past the buffer rather than an exception.
`npm run test:fuzz:native` builds `fuzz/pcsc_fuzz.cc` with clang under
AddressSanitizer and UndefinedBehaviorSanitizer and runs it over `fuzz/corpus`
(`--seconds N` for the budget, 60 by default; `--target pcsc` for this addon
alone, since the runner covers the Touch ID addon too). A sanitizer report or
a broken invariant fails the run and leaves the reproducing input in
`native-fuzz-out/pcsc/`; replay it with `native-fuzz-out/pcsc_fuzz <file>`.

The security workflow runs it on every push and for a quarter of an hour on
the weekly schedule, files findings in the Security tab, and attaches the
reproducer to the run.

Everything the target reaches lives in `src/pcsc_parse.h`. Parsing added to
the addon belongs there, or it ships without coverage.

## Runtime

Linux links `libpcsclite.so.1` dynamically. Without it the addon fails to
load, `isLoaded()` is false and every call rejects with `unavailable`. With
the library but no `pcscd`, calls reject with `no-service`. The OATH driver
turns both into a message telling the user what to install or start.

## Contract

- Return codes are normalised to their unsigned 32-bit value, so
  `0x8010001D` (`SCARD_E_NO_SERVICE`) is the same number on every platform.
- A `Card` handles one call at a time. A second call while one is in flight
  rejects with `busy`; PC/SC gives no guarantees for that case and the
  driver serialises anyway.
- A connection is `SHARED`. Another process can select a different applet on
  the card between our calls, so the driver wraps every sequence in a
  transaction and begins each one with `SELECT`.
- `SCARD_E_NO_READERS_AVAILABLE` from `listReaders` is reported as an empty
  list: nothing plugged in is a normal state.

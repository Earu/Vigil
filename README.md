# Vigil Password Manager

A modern, secure password manager with a beautiful user interface, built using Electron and React.

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/3aa6caa6-0370-4428-a8f6-2614d990f80e" />

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/aac93a3c-9626-4eb4-a197-041878b83b1b" />

## Features

| Feature | Details |
| --- | --- |
| KeePass databases | Full .kdbx support, compatible with KeePass and every other .kdbx client |
| Modern UI | Clean, dense interface with light and dark themes |
| File attachments | Add, download and remove files on any entry |
| Entry history | Every edit records a revision, browse and restore past versions |
| One-time codes | TOTP with live codes and HOTP (counter-based), add secrets by scanning a QR code (screen, clipboard or image) or a Google Authenticator export |
| Browser integration | Autofill, save and update logins via the KeePassXC-Browser extension (Windows, Linux, macOS) |
| Passkeys | Create and use passkeys in the browser, stored in your database |
| Import | Bitwarden, LastPass, 1Password, KeePassXC and generic CSV, format auto-detected |
| Export | CSV export |
| Password generator | Character and passphrase modes with entropy estimate |
| Custom fields | Arbitrary entry fields with per-field protection |
| Tags | Tag any entry, click a tag to filter the whole vault |
| Search | Field-scoped terms (`title:`, `user:`, `url:`, `notes:`, `tag:`), quoted phrases, matches tags and custom fields |
| Key files | Unlock with a key file alongside the master password |
| Hardware keys | YubiKey challenge-response as an extra unlock factor |
| SSH agent | Private keys stored as attachments are loaded into your ssh-agent on unlock and removed on lock, KeeAgent-compatible entries |
| Entry expiry | Expiry dates with visual indicators for expired entries |
| Recycle bin | Deleted entries and groups can be restored or purged |
| Security report | Breached, reused, weak, exposed and expired credentials (HaveIBeenPwned) |
| Biometrics | Windows Hello/biometric unlock, credentials in the system keychain |
| Strong crypto | Argon2 password hashing, Argon2id defaults for new databases |
| Database settings | Master password change, KDF tuning, name, description, history retention |
| Multiple vaults | Each database opens in its own window |
| Large vaults | Virtualized entry list, fast unlock, search and save with thousands of entries |
| Safe saves | Atomic writes, external changes to the file are merged, not clobbered |
| Auto-updates | Self-updating builds on Windows, macOS and Linux |
| Cross-platform | Windows, macOS, Linux |

## Download

Grab the latest installer from the [releases page](https://github.com/Earu/Vigil/releases): Windows installer (x64), Linux AppImage (x64) or macOS DMG (Apple Silicon). The builds update themselves when a new release is published.

Every release file carries a build provenance attestation: a signed record that it was produced by this repository's release workflow from a given commit. Check a download with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify vigil-linux-x64-v1.5.0.AppImage --repo Earu/Vigil
```

### Reproducible builds

The application code inside each release, the `app.asar` archive, is reproducible: the same commit built with the same Node major and on the same platform gives the same bytes. Each release ships a `*.asar.sha256` file per platform, attested like the installers, and CI rebuilds the archive on two runners from two paths and fails if they differ.

To check a release yourself, extract `app.asar` from the installer (`--appimage-extract` on the AppImage, 7-Zip on the Windows installer, the zip on macOS; it sits under `resources/`) and compare its SHA-256 with the shipped file. To go further, rebuild at the release tag and compare against your own output:

```bash
npm ci
npm run electron:build -- --dir
node scripts/asar-hash.mjs
```

The installer wrappers themselves are not reproducible: they embed timestamps and, on macOS, a signature.

The native modules (keytar, argon2, node-hid, and on Windows passport-desktop) sit outside the archive, under `resources/app.asar.unpacked/dist-electron`. Their SHA-256 per platform is pinned in `electron/native-pins.mjs` and the build refuses any other bytes, so those files can be checked against the pins directly.

## Development

### Prerequisites

- Node.js (Latest LTS version recommended)
- npm or yarn package manager

### Installation

1. Clone the repository:
```bash
git clone https://github.com/Earu/Vigil.git
cd Vigil
```

2. Install dependencies:
```bash
npm install
# or
yarn
```

### Development Scripts

- `npm run dev` - Start Vite development server
- `npm run electron:dev` - Start Electron development environment
- `npm run build` - Build the application
- `npm run electron:build` - Build the Electron application for distribution

## Building

The application can be built for different platforms:

- Windows (NSIS installer)
- macOS (DMG)
- Linux (AppImage)

Build configuration is handled through electron-builder. The application automatically associates with `.kdbx` files for seamless database opening.

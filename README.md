# Vigil Password Manager

A modern, secure password manager with a beautiful user interface, built using Electron and React.

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/3aa6caa6-0370-4428-a8f6-2614d990f80e" />

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/aac93a3c-9626-4eb4-a197-041878b83b1b" />

## Features

| Feature | Details |
| --- | --- |
| KeePass databases | Full .kdbx support, compatible with KeePass, KeePassXC and others |
| Modern UI | Clean, dense interface with light and dark themes |
| File attachments | Add, download and remove files on any entry |
| Entry history | Every edit records a revision, browse and restore past versions |
| One-time codes | TOTP with live codes, add secrets by scanning a QR code (screen, clipboard or image) or a Google Authenticator export |
| Browser integration | Autofill, save and update logins via the KeePassXC-Browser extension (Windows, Linux, macOS) |
| Passkeys | Create and use passkeys in the browser, stored in your database, KeePassXC-compatible |
| Import | Bitwarden, LastPass, 1Password, KeePassXC and generic CSV, format auto-detected |
| Export | KeePassXC-compatible CSV export |
| Password generator | Character and passphrase modes with entropy estimate |
| Custom fields | Arbitrary entry fields with per-field protection |
| Tags | Tag any entry, click a tag to filter the whole vault |
| Search | Field-scoped terms (`title:`, `user:`, `url:`, `notes:`, `tag:`), quoted phrases, matches tags and custom fields |
| Key files | Unlock with a key file alongside the master password |
| Hardware keys | YubiKey challenge-response as an extra unlock factor, KeePassXC-compatible |
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

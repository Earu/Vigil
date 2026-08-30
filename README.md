# Vigil Password Manager

A modern, secure password manager with a beautiful user interface, built using Electron and React.

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/3aa6caa6-0370-4428-a8f6-2614d990f80e" />

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/aac93a3c-9626-4eb4-a197-041878b83b1b" />

## Features

- Secure KeePass (.kdbx) database support
- Modern and intuitive user interface
- HaveIBeenPwned integration for password security checks
- Windows Hello/Biometric authentication support
- Secure credential storage using system keychain
- Strong encryption with Argon2 password hashing
- Cross-platform support (Windows, macOS, Linux)

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

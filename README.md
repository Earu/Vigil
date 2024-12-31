# Vigil Password Manager

A modern, secure password manager with a beautiful user interface, built using Electron and React.

![password_view](https://github.com/user-attachments/assets/443f725a-b249-4305-aa83-d3768a6afb2f)
![security_report](https://github.com/user-attachments/assets/4a33a8b9-1985-4750-810a-bc20fe85747e)


## Features

- 🔒 Secure KeePass (.kdbx) database support
- 🎨 Modern and intuitive user interface
- 🔍 HaveIBeenPwned integration for password security checks
- 🔐 Windows Hello/Biometric authentication support
- 🔑 Secure credential storage using system keychain
- 🛡️ Strong encryption with Argon2 password hashing
- 🌐 Cross-platform support (Windows, macOS, Linux)

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

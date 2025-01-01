import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

async function buildFirefoxDecrypt() {
    try {
        // Install PyInstaller if not already installed
        await execFileAsync('pip', ['install', 'pyinstaller']);

        // Build the executable
        await execFileAsync('pyinstaller', [
            '--onefile',
            '--clean',
            '--name', 'firefox_decrypt',
            'electron/firefox_decrypt_repo/firefox_decrypt.py'
        ]);

        // Copy the executable to dist-electron
        const exeName = process.platform === 'win32' ? 'firefox_decrypt.exe' : 'firefox_decrypt';
        const sourcePath = path.join(process.cwd(), 'dist', exeName);
        const targetPath = path.join(process.cwd(), 'dist-electron', exeName);

        fs.copyFileSync(sourcePath, targetPath);
        console.log('Successfully built and copied Firefox decrypt executable');

        // Clean up PyInstaller build files
        const cleanupPaths = ['build/firefox_decrypt', 'dist/firefox_decrypt', 'firefox_decrypt.spec'];
        for (const cleanupPath of cleanupPaths) {
            fs.rmSync(path.join(process.cwd(), cleanupPath), { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Failed to build Firefox decrypt executable:', error);
        process.exit(1);
    }
}

buildFirefoxDecrypt();
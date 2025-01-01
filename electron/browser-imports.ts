import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import * as sqlite3 from 'sqlite3';
import { homedir } from 'os';
import { createDecipheriv } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import keytar from './get-keytar';

const execFileAsync = promisify(execFile);

interface BrowserPassword {
    url: string;
    username: string;
    password: string;
}

interface LoginRow {
    origin_url: string;
    username_value: string;
    password_value: Buffer;
}

function getChromiumProfilePath(browser: string): string {
    const platform = process.platform;
    const home = homedir();

    const paths = {
        win32: {
            chrome: join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'),
            edge: join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default'),
            brave: join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'),
        },
        darwin: {
            chrome: join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default'),
            edge: join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Default'),
            brave: join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'Default'),
        }
    };

    return paths[platform as keyof typeof paths]?.[browser as keyof typeof paths['win32']] || '';
}

async function decryptChromiumPassword(encryptedPassword: Buffer, platform: string): Promise<string> {
    try {
        if (platform === 'win32') {
            // Use PowerShell to decrypt with DPAPI
            const script = `
                $bytes = [byte[]]@(${Array.from(encryptedPassword).join(',')});
                $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser');
                [System.Text.Encoding]::UTF8.GetString($decrypted)
            `;

            const { stdout } = await execFileAsync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                script
            ]);

            return stdout.trim();
        } else if (platform === 'darwin' && keytar) {
            // On macOS, get the encryption key from keychain using keytar
            const key = await keytar.getPassword('Chrome Safe Storage', 'Chrome');
            if (!key) {
                throw new Error('Could not get Chrome encryption key from keychain');
            }

            const iv = Buffer.alloc(16, 0);
            const decipher = createDecipheriv('aes-128-cbc', key, iv);
            let decrypted = decipher.update(encryptedPassword);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            return decrypted.toString('utf-8');
        } else {
            throw new Error('Unsupported platform or missing required modules for password decryption');
        }
    } catch (error) {
        console.error('Failed to decrypt password:', error);
        return '';
    }
}

function getFirefoxProfilePath(): string {
    const platform = process.platform;
    const home = homedir();

    const paths = {
        win32: join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
        darwin: join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'),
    };

    return paths[platform as keyof typeof paths] || '';
}

async function getChromiumPasswords(browser: string): Promise<BrowserPassword[]> {
    const passwords: BrowserPassword[] = [];
    const profilePath = getChromiumProfilePath(browser);
    if (!profilePath) return passwords;

    const dbPath = join(profilePath, 'Login Data');
    const tempDbPath = join(homedir(), '.temp_login_data');

    try {
        // Copy the database using Node.js fs
        const dbContent = readFileSync(dbPath);
        writeFileSync(tempDbPath, dbContent);

        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(tempDbPath, sqlite3.OPEN_READONLY, (error: Error | null) => {
                if (error) reject(error);
            });

            db.each<LoginRow>(
                `SELECT origin_url, username_value, password_value
                 FROM logins
                 WHERE username_value != '' OR password_value != ''`,
                async (error: Error | null, row: LoginRow) => {
                    if (error) {
                        console.error('Error reading row:', error);
                        return;
                    }

                    const decryptedPassword = await decryptChromiumPassword(
                        row.password_value,
                        process.platform
                    );

                    if (decryptedPassword) {
                        passwords.push({
                            url: row.origin_url,
                            username: row.username_value,
                            password: decryptedPassword
                        });
                    }
                },
                (error: Error | null) => {
                    db.close();
                    // Clean up temp file
                    try {
                        unlinkSync(tempDbPath);
                    } catch (e) {
                        console.error('Failed to delete temp file:', e);
                    }
                    if (error) reject(error);
                    else resolve(passwords);
                }
            );
        });
    } catch (error) {
        console.error(`Failed to read ${browser} passwords:`, error);
        // Clean up temp file in case of error
        try {
            unlinkSync(tempDbPath);
        } catch (e) {
            // Ignore cleanup errors
        }
        return passwords;
    }
}

async function getFirefoxPasswords(): Promise<BrowserPassword[]> {
    const passwords: BrowserPassword[] = [];
    const profilesPath = getFirefoxProfilePath();
    if (!profilesPath) return passwords;

    try {
        // Find the default profile
        const profiles = readFileSync(join(profilesPath, 'profiles.ini'), 'utf-8');
        const defaultProfile = profiles
            .split('\n')
            .find(line => line.includes('Default=1'))
            ?.split('=')[1]
            .trim();

        if (!defaultProfile) return passwords;

        const profilePath = join(profilesPath, defaultProfile);
        // Firefox implementation would go here

        return passwords;
    } catch (error) {
        console.error('Failed to read Firefox passwords:', error);
        return passwords;
    }
}

export async function importBrowserPasswords(browsers: string[]): Promise<BrowserPassword[]> {
    const allPasswords: BrowserPassword[] = [];

    for (const browser of browsers) {
        try {
            if (['chrome', 'edge', 'brave'].includes(browser)) {
                const passwords = await getChromiumPasswords(browser);
                allPasswords.push(...passwords);
            } else if (browser === 'firefox') {
                const passwords = await getFirefoxPasswords();
                allPasswords.push(...passwords);
            }
        } catch (error) {
            console.error(`Failed to import passwords from ${browser}:`, error);
        }
    }

    return allPasswords;
}
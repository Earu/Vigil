import { readFileSync } from 'fs';
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
            chrome: join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
            edge: join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
            brave: join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
            vivaldi: join(home, 'AppData', 'Local', 'Vivaldi', 'User Data'),
            opera: join(home, 'AppData', 'Local', 'Opera Software', 'Opera Stable'),
            chromium: join(home, 'AppData', 'Local', 'Chromium', 'User Data'),
        },
        darwin: {
            chrome: join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
            edge: join(home, 'Library', 'Application Support', 'Microsoft Edge'),
            brave: join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
            vivaldi: join(home, 'Library', 'Application Support', 'Vivaldi'),
            opera: join(home, 'Library', 'Application Support', 'com.operasoftware.Opera'),
            chromium: join(home, 'Library', 'Application Support', 'Chromium'),
        }
    };

    return paths[platform as keyof typeof paths]?.[browser as keyof typeof paths['win32']] || '';
}

async function getLocalStateKey(profilePath: string): Promise<Buffer | null> {
    try {
        const localStatePath = join(profilePath, 'Local State');
        const localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
        const encryptedKey = Buffer.from(localState.os_crypt.encrypted_key, 'base64');

        // Remove 'DPAPI' prefix
        const keyWithoutPrefix = encryptedKey.slice(5);

        // Decrypt the key using DPAPI
        const script = `
            Add-Type -AssemblyName System.Security;
            $bytes = [byte[]]@(${Array.from(keyWithoutPrefix).join(',')});
            $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
            if ($decrypted) {
                [Convert]::ToBase64String($decrypted)
            } else {
                Write-Error "Failed to decrypt key"
            }
        `;

        const { stdout } = await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script
        ]);

        return Buffer.from(stdout.trim(), 'base64');
    } catch (error) {
        console.error('Failed to get local state key:', error);
        return null;
    }
}

async function decryptChromiumPassword(encryptedPassword: Buffer, platform: string, masterKey: Buffer | null): Promise<string> {
    try {
        if (platform === 'win32') {
            // Check if the data starts with 'v10' or 'v11' prefix
            const prefix = encryptedPassword.slice(0, 3).toString();

            if (prefix === 'v10' || prefix === 'v11') {
                if (!masterKey) {
                    throw new Error('Master key is required for v10/v11 encryption');
                }

                // Get the nonce (12 bytes) and ciphertext
                const nonce = encryptedPassword.slice(3, 15);
                const ciphertext = encryptedPassword.slice(15, -16);
                const tag = encryptedPassword.slice(-16);

                // Use Node.js crypto for AES-GCM decryption
                const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
                decipher.setAuthTag(tag);

                let decrypted = decipher.update(ciphertext);
                decrypted = Buffer.concat([decrypted, decipher.final()]);
                return decrypted.toString('utf8');
            } else {
                // For older versions, use DPAPI directly
                const script = `
                    Add-Type -AssemblyName System.Security;
                    $bytes = [byte[]]@(${Array.from(encryptedPassword).join(',')});
                    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
                    if ($decrypted) {
                        [System.Text.Encoding]::UTF8.GetString($decrypted)
                    } else {
                        Write-Error "Failed to decrypt data"
                    }
                `;

                const { stdout } = await execFileAsync('powershell.exe', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    script
                ]);

                return stdout.trim();
            }
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

async function getChromiumPasswords(browser: string): Promise<BrowserPassword[]> {
    const passwords: BrowserPassword[] = [];
    const profilePath = getChromiumProfilePath(browser);
    if (!profilePath) return passwords;

    try {
        // Get the master key first
        const masterKey = await getLocalStateKey(profilePath);
        const dbPath = join(profilePath, 'Default', 'Login Data');

        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error: Error | null) => {
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
                        process.platform,
                        masterKey
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

                    if (error) reject(error);
                    else resolve(passwords);
                }
            );
        });
    } catch (error) {
        console.error(`Failed to read ${browser} passwords:`, error);
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
            }
        } catch (error) {
            console.error(`Failed to import passwords from ${browser}:`, error);
        }
    }

    return allPasswords;
}
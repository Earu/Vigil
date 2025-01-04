import * as kdbxweb from 'kdbxweb';
import { KeepassDatabaseService } from './KeepassDatabaseService';

interface CsvPassword {
    url: string;
    username: string;
    password: string;
}

export class CsvImportService {
    private static parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }

        result.push(current.trim());
        return result;
    }

    public static async importFromCsv(file: File): Promise<CsvPassword[]> {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim());

        if (lines.length === 0) {
            throw new Error('CSV file is empty');
        }

        const passwords: CsvPassword[] = [];
        const headerLine = this.parseCSVLine(lines[0]);
        const headers = headerLine.map(h => h.toLowerCase());

        const urlIndex = headers.findIndex(h => h === 'url' || h === 'origin');
        const usernameIndex = headers.findIndex(h => h === 'username' || h === 'username field' || h === 'usernamevalue');
        const passwordIndex = headers.findIndex(h => h === 'password' || h === 'password field' || h === 'passwordvalue');

        if (passwordIndex === -1 || (urlIndex === -1 && usernameIndex === -1)) {
            throw new Error('Could not find required columns (url/origin, username, password) in the CSV file');
        }

        for (let i = 1; i < lines.length; i++) {
            const values = this.parseCSVLine(lines[i]);
            if (values.length === 0) continue;

            const url = urlIndex !== -1 ? values[urlIndex] : "";
            const username = usernameIndex !== -1 ? values[usernameIndex] : "";
            const password = values[passwordIndex];

            if (!password) continue;

            passwords.push({ url, username, password });
        }

        if (passwords.length === 0) {
            throw new Error('No valid password entries found in CSV');
        }

        return passwords;
    }

    public static async importToDatabase(passwords: CsvPassword[], kdbxDb: kdbxweb.Kdbx): Promise<void> {
        const importedGroup = kdbxDb.createGroup(kdbxDb.getDefaultGroup(), 'Imported');
        
        for (const csvPassword of passwords) {
            const entry = kdbxDb.createEntry(importedGroup);
            entry.fields.set('Title', new URL(csvPassword.url).hostname);
            entry.fields.set('UserName', csvPassword.username);
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(csvPassword.password));
            entry.fields.set('URL', csvPassword.url);
        }

        const database = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
        await KeepassDatabaseService.saveDatabase(database, kdbxDb);
    }
} 
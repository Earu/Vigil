import { Database } from '../types/database';
import { KeepassDatabaseService } from './KeepassDatabaseService';
import * as kdbxweb from 'kdbxweb';

export class ExtensionService {
    static async handleGetAvailableEntries(database: Database) {
        const entries = KeepassDatabaseService.getAllEntriesFromGroup(database.root);
        return entries.map(entry => ({
            id: entry.id,
            url: entry.url || '',
            username: entry.username
        }));
    }

    static async handleGetCredentials(database: Database, entryId: string) {
        const entries = KeepassDatabaseService.getAllEntriesFromGroup(database.root);
        const entry = entries.find(e => e.id === entryId);

        if (!entry) {
            throw new Error('Entry not found');
        }

        return {
            password: KeepassDatabaseService.getPasswordString(entry.password)
        };
    }

    static async verifyDatabaseAccess(dbPath: string, password: string) {
        const dataBuffer = await window.electron?.readFile(dbPath);
        if (!dataBuffer?.success || !dataBuffer.data) {
            throw new Error('Failed to read database file');
        }

        const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
        await kdbxweb.Kdbx.load(dataBuffer.data.buffer, credentials);
    }

    static async handleAuthenticationSuccess(connectionId: string) {
        await window.electron?.trustConnection(connectionId);
    }

    static async handleAuthenticationFailure(requestId: string) {
        await window.electron?.respondToExtension(requestId, {
            error: 'Authentication failed'
        });
    }
}

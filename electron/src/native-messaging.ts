import { Buffer } from 'buffer';
import fs from 'fs';
import path from 'path';

const EXTENSION_CONFIG = {
    // Firefox extension ID (from manifest.json browser_specific_settings.gecko.id)
    firefoxId: "autofill@vigil.app",
    
    // Chrome extension ID (from chrome://extensions in dev mode, or Chrome Web Store after publishing)
    // During development, you'll need to update this with your local extension ID
    chromeIds: [
        // Add your development ID here during testing
        "chrome-extension://DEVELOPMENT-ID/",
        // Add your production ID here after publishing
        "chrome-extension://PRODUCTION-ID/"
    ]
};

interface NativeMessage {
    nonce: string;
    timestamp: number;
    action: string;
    data: any;
}

export function setupNativeMessaging(): void {
    // Set up message handling from stdin
    process.stdin.on('readable', () => {
        const input: Buffer[] = [];
        let chunk: Buffer | null;
        while ((chunk = process.stdin.read() as Buffer | null)) {
            input.push(chunk);
        }
        if (input.length > 0) {
            const buffer = Buffer.concat(input);
            handleNativeMessage(buffer);
        }
    });

    // Ensure native messaging manifest exists
    setupNativeMessagingManifest();
}

function getManifestPath(): string[] {
    const manifestName = "com.vigil.autofill.json";
    
    // Platform-specific base paths
    const basePaths: { [key: string]: string[] } = {
        darwin: [
            // Chrome/Chromium
            path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
            path.join(process.env.HOME || '', 'Library/Application Support/Chromium/NativeMessagingHosts'),
            // Firefox
            path.join(process.env.HOME || '', 'Library/Application Support/Mozilla/NativeMessagingHosts')
        ],
        linux: [
            // Chrome/Chromium
            path.join(process.env.HOME || '', '.config/google-chrome/NativeMessagingHosts'),
            path.join(process.env.HOME || '', '.config/chromium/NativeMessagingHosts'),
            // Firefox
            path.join(process.env.HOME || '', '.mozilla/native-messaging-hosts')
        ],
        win32: [
            // Chrome/Chromium
            path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/NativeMessagingHosts'),
            path.join(process.env.LOCALAPPDATA || '', 'Chromium/NativeMessagingHosts'),
            // Firefox
            path.join(process.env.APPDATA || '', 'Mozilla/NativeMessagingHosts')
        ]
    };

    const paths = basePaths[process.platform as keyof typeof basePaths] || [];
    return paths.map(p => path.join(p, manifestName));
}

function setupNativeMessagingManifest() {
    const manifestPaths = getManifestPath();
    if (manifestPaths.length === 0) return;

    // Chrome/Chromium manifest
    const chromeManifest = {
        name: "com.vigil.password_manager",
        description: "Vigil Password Manager Native Messaging Host",
        path: process.execPath,
        type: "stdio",
        allowed_origins: EXTENSION_CONFIG.chromeIds
    };

    // Firefox manifest
    const firefoxManifest = {
        name: "com.vigil.password_manager",
        description: "Vigil Password Manager Native Messaging Host",
        path: process.execPath,
        type: "stdio",
        allowed_extensions: [EXTENSION_CONFIG.firefoxId]
    };

    for (const manifestPath of manifestPaths) {
        try {
            // Ensure directory exists
            const manifestDir = path.dirname(manifestPath);
            if (!fs.existsSync(manifestDir)) {
                fs.mkdirSync(manifestDir, { recursive: true });
            }

            // Write appropriate manifest based on path
            const manifest = manifestPath.includes('Mozilla') ? firefoxManifest : chromeManifest;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
            
            // Set appropriate permissions on Unix-like systems
            if (process.platform !== 'win32') {
                fs.chmodSync(manifestPath, 0o644);
            }

            console.log(`Created native messaging manifest at: ${manifestPath}`);
            console.log('Manifest contents:', JSON.stringify(manifest, null, 2));
        } catch (error) {
            console.error(`Error creating manifest at ${manifestPath}:`, error);
        }
    }
}

function handleNativeMessage(buffer: Buffer): void {
    try {
        // First 4 bytes are length prefix
        const length = buffer.readUInt32LE(0);
        const messageBuffer = buffer.slice(4, 4 + length);
        
        const message: NativeMessage = JSON.parse(messageBuffer.toString());
        
        // Basic sanity check for timestamp
        const now = Date.now();
        if (Math.abs(now - message.timestamp) > 5 * 60 * 1000) {
            throw new Error('Message expired');
        }

        // Process the message
        processMessage(message);
    } catch (error) {
        sendResponse({ error: 'Invalid message format' });
    }
}

function processMessage(message: NativeMessage): void {
    console.log(message);
    switch (message.action) {
        case 'GET_CREDENTIALS':
            // Handle credential retrieval
            // This should integrate with your KeePass database access
            break;
        default:
            sendResponse({ error: 'Unknown action' });
    }
}

function sendResponse(response: any): void {
    const message = {
        timestamp: Date.now(),
        data: response
    };
    
    const messageBuffer = Buffer.from(JSON.stringify(message));
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(messageBuffer.length, 0);
    
    process.stdout.write(Buffer.concat([lengthBuffer, messageBuffer]));
} 
import path from 'path';

// Native messaging manifest locations and contents for the KeePassXC-Browser
// integration. Pure data/logic only (no electron imports) so it can be unit
// tested directly.

export const HOST_NAME = 'org.keepassxc.keepassxc_browser';

// KeePassXC uses the same origins for every Chromium-family browser,
// including Edge (verified against their NativeMessageInstaller)
export const CHROME_ORIGINS = [
    'chrome-extension://oboonakemofpalcgghocfoadofidjkkk/',
    'chrome-extension://pdffhmdngciaglkoonimfcmckehcpafo/',
];
export const FIREFOX_EXTENSIONS = ['keepassxc-browser@keepassxc.org'];

export type ManifestType = 'firefox' | 'chromium';

export interface ManifestTarget {
    browser: string;
    dir: string;
    type: ManifestType;
    // Install if ANY of these paths exists. When absent, the default rule
    // applies: install if the manifest dir's parent exists (i.e. the browser
    // has created its profile directory).
    detect?: string[];
}

// Windows browsers find native messaging hosts through the registry: the
// key's default value points at the manifest JSON. Brave and Vivaldi read
// Chrome's key on Windows, so these four cover the same set as the manifest
// directories elsewhere (matches what KeePassXC registers)
export interface RegistryTarget {
    browser: string;
    key: string;
    type: ManifestType;
}

export function registryTargets(): RegistryTarget[] {
    return [
        { browser: 'Firefox', key: `Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`, type: 'firefox' },
        { browser: 'Chrome', key: `Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, type: 'chromium' },
        { browser: 'Chromium', key: `Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`, type: 'chromium' },
        { browser: 'Edge', key: `Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`, type: 'chromium' },
    ];
}

export function manifestTargets(platform: NodeJS.Platform, home: string): ManifestTarget[] {
    if (platform === 'linux') {
        // Firefox may read either the classic ~/.mozilla or, on XDG-patched
        // builds (CachyOS, openSUSE), ~/.config/mozilla; write both when any
        // sign of Firefox exists
        const firefoxSigns = [
            '/usr/bin/firefox',
            path.join(home, '.mozilla'),
            path.join(home, '.config/mozilla'),
        ];
        return [
            { browser: 'Firefox', dir: path.join(home, '.mozilla/native-messaging-hosts'), type: 'firefox', detect: firefoxSigns },
            { browser: 'Firefox (XDG)', dir: path.join(home, '.config/mozilla/native-messaging-hosts'), type: 'firefox', detect: firefoxSigns },
            { browser: 'Firefox (Flatpak)', dir: path.join(home, '.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts'), type: 'firefox' },
            { browser: 'Chrome', dir: path.join(home, '.config/google-chrome/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Chromium', dir: path.join(home, '.config/chromium/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Brave', dir: path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Vivaldi', dir: path.join(home, '.config/vivaldi/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Edge', dir: path.join(home, '.config/microsoft-edge/NativeMessagingHosts'), type: 'chromium' },
        ];
    }
    if (platform === 'darwin') {
        const appSupport = path.join(home, 'Library/Application Support');
        return [
            {
                browser: 'Firefox',
                dir: path.join(appSupport, 'Mozilla/NativeMessagingHosts'),
                type: 'firefox',
                // AS/Mozilla usually doesn't exist even with Firefox installed
                // (profiles live in AS/Firefox), so detect the app instead
                detect: ['/Applications/Firefox.app', path.join(appSupport, 'Firefox')],
            },
            { browser: 'Chrome', dir: path.join(appSupport, 'Google/Chrome/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Chromium', dir: path.join(appSupport, 'Chromium/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Brave', dir: path.join(appSupport, 'BraveSoftware/Brave-Browser/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Vivaldi', dir: path.join(appSupport, 'Vivaldi/NativeMessagingHosts'), type: 'chromium' },
            { browser: 'Edge', dir: path.join(appSupport, 'Microsoft Edge/NativeMessagingHosts'), type: 'chromium' },
        ];
    }
    return [];
}

// Only write into browsers that exist on this machine
export function selectTargets(targets: ManifestTarget[], exists: (p: string) => boolean): ManifestTarget[] {
    return targets.filter((target) =>
        target.detect
            ? target.detect.some(exists)
            : exists(path.dirname(target.dir))
    );
}

function manifest(wrapperPath: string, extra: Record<string, unknown>): string {
    return JSON.stringify({
        name: HOST_NAME,
        description: 'Vigil KeePassXC-Browser integration',
        path: wrapperPath,
        type: 'stdio',
        ...extra,
    }, null, 4);
}

export function chromiumManifest(wrapperPath: string): string {
    return manifest(wrapperPath, { allowed_origins: CHROME_ORIGINS });
}

export function firefoxManifest(wrapperPath: string): string {
    return manifest(wrapperPath, { allowed_extensions: FIREFOX_EXTENSIONS });
}

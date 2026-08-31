import { describe, it, expect } from 'vitest';
import {
    HOST_NAME,
    chromiumManifest,
    firefoxManifest,
    manifestTargets,
    selectTargets,
} from '../electron/src/browser-manifests';

const HOME = '/home/user';
const MAC_HOME = '/Users/user';
const AS = `${MAC_HOME}/Library/Application Support`;

describe('manifestTargets', () => {
    it('lists the linux manifest directories', () => {
        const dirs = manifestTargets('linux', HOME).map(t => t.dir);
        expect(dirs).toEqual([
            `${HOME}/.mozilla/native-messaging-hosts`,
            `${HOME}/.config/mozilla/native-messaging-hosts`,
            `${HOME}/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts`,
            `${HOME}/.config/google-chrome/NativeMessagingHosts`,
            `${HOME}/.config/chromium/NativeMessagingHosts`,
            `${HOME}/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts`,
            `${HOME}/.config/vivaldi/NativeMessagingHosts`,
            `${HOME}/.config/microsoft-edge/NativeMessagingHosts`,
        ]);
    });

    it('lists the macOS manifest directories', () => {
        const dirs = manifestTargets('darwin', MAC_HOME).map(t => t.dir);
        expect(dirs).toEqual([
            `${AS}/Mozilla/NativeMessagingHosts`,
            `${AS}/Google/Chrome/NativeMessagingHosts`,
            `${AS}/Chromium/NativeMessagingHosts`,
            `${AS}/BraveSoftware/Brave-Browser/NativeMessagingHosts`,
            `${AS}/Vivaldi/NativeMessagingHosts`,
            `${AS}/Microsoft Edge/NativeMessagingHosts`,
        ]);
    });

    it('detects Firefox on macOS via the app bundle or profile directory', () => {
        const firefox = manifestTargets('darwin', MAC_HOME).find(t => t.type === 'firefox');
        expect(firefox?.detect).toEqual([
            '/Applications/Firefox.app',
            `${AS}/Firefox`,
        ]);
    });

    it('returns nothing on unsupported platforms', () => {
        expect(manifestTargets('win32', 'C:\\Users\\user')).toEqual([]);
    });
});

describe('selectTargets', () => {
    it('selects Firefox on macOS when only the app bundle exists', () => {
        const selected = selectTargets(
            manifestTargets('darwin', MAC_HOME),
            p => p === '/Applications/Firefox.app'
        );
        expect(selected.map(t => t.browser)).toEqual(['Firefox']);
    });

    it('selects only Chrome when only its profile directory exists', () => {
        const selected = selectTargets(
            manifestTargets('darwin', MAC_HOME),
            p => p === `${AS}/Google/Chrome`
        );
        expect(selected.map(t => t.browser)).toEqual(['Chrome']);
    });

    it('does not select Chrome when only other Google apps created AS/Google', () => {
        const selected = selectTargets(
            manifestTargets('darwin', MAC_HOME),
            p => p === `${AS}/Google`
        );
        expect(selected).toEqual([]);
    });

    it('writes both classic and XDG Firefox directories on linux when ~/.mozilla exists', () => {
        const selected = selectTargets(
            manifestTargets('linux', HOME),
            p => p === `${HOME}/.mozilla`
        );
        expect(selected.map(t => t.browser)).toEqual(['Firefox', 'Firefox (XDG)']);
    });
});

describe('manifest contents', () => {
    it('builds a chromium manifest with allowed_origins', () => {
        const parsed = JSON.parse(chromiumManifest('/path/to/vigil-proxy.sh'));
        expect(parsed.name).toBe(HOST_NAME);
        expect(parsed.path).toBe('/path/to/vigil-proxy.sh');
        expect(parsed.type).toBe('stdio');
        expect(parsed.allowed_origins.length).toBeGreaterThan(0);
        expect(parsed.allowed_extensions).toBeUndefined();
    });

    it('builds a firefox manifest with allowed_extensions', () => {
        const parsed = JSON.parse(firefoxManifest('/path/to/vigil-proxy.sh'));
        expect(parsed.name).toBe(HOST_NAME);
        expect(parsed.path).toBe('/path/to/vigil-proxy.sh');
        expect(parsed.allowed_extensions).toEqual(['keepassxc-browser@keepassxc.org']);
        expect(parsed.allowed_origins).toBeUndefined();
    });
});

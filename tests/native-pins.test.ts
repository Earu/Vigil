import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Every native binary that ships outside app.asar is pinned by SHA-256 per
// platform; the copy step refuses anything else. These check the table
// itself: that it covers the release targets, names the versions the
// lockfile installs, and matches the binaries installed here

const { NATIVE_PINS, checkNativeModule } = await import('../electron/native-pins.mjs');

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// What the release workflow builds, per module, in the pin table's key form
const RELEASE_TARGETS: Record<string, string[]> = {
    keytar: ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'],
    '@node-rs/argon2': ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-arm64', 'win32-x64-msvc'],
    'node-hid': ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'],
    'passport-desktop': ['win32-x64-msvc'],
};

// Where each module's binary and package.json sit on this host, mirroring
// copy-native-modules.mjs; null when the host is not a pinned target
const installed = (): Array<{ module: string; file: string; target: string }> => {
    const { platform, arch } = process;
    if (platform !== 'linux') return [];
    return [
        { module: 'keytar', file: 'node_modules/keytar/build/Release/keytar.node', target: `${platform}-${arch}` },
        { module: '@node-rs/argon2', file: `node_modules/@node-rs/argon2-${platform}-${arch}-gnu/argon2.${platform}-${arch}-gnu.node`, target: `${platform}-${arch}-gnu` },
        { module: 'node-hid', file: `node_modules/node-hid/prebuilds/HID_hidraw-${platform}-${arch}/node-napi-v4.node`, target: `${platform}-${arch}` },
    ];
};

describe('native pins', () => {
    it('pins every module the copy step ships', () => {
        const copy = fs.readFileSync(path.join(root, 'electron', 'copy-native-modules.mjs'), 'utf8');
        const shipped = copy.match(/modulesToCopy = \[([^\]]*)\]/)![1].match(/'[^']+'/g)!.map(s => s.slice(1, -1));
        expect(shipped.length).toBeGreaterThan(0);
        for (const module of [...shipped, 'passport-desktop']) expect(NATIVE_PINS[module], module).toBeDefined();
    });

    it('covers every platform the release workflow builds', () => {
        for (const [module, targets] of Object.entries(RELEASE_TARGETS)) {
            for (const target of targets) {
                expect(NATIVE_PINS[module].sha256[target], `${module} ${target}`).toMatch(/^[0-9a-f]{64}$/);
            }
        }
    });

    it('pins the versions the lockfile installs', () => {
        expect(lock.packages['node_modules/keytar'].version).toBe(NATIVE_PINS.keytar.version);
        expect(lock.packages['node_modules/@node-rs/argon2'].version).toBe(NATIVE_PINS['@node-rs/argon2'].version);
        expect(lock.packages['node_modules/node-hid'].version).toBe(NATIVE_PINS['node-hid'].version);
        expect(lock.packages['node_modules/passport-desktop'].version).toBe(NATIVE_PINS['passport-desktop'].version);
        // The platform packages carry the same version as their wrapper
        expect(lock.packages['node_modules/@node-rs/argon2-linux-x64-gnu'].version).toBe(NATIVE_PINS['@node-rs/argon2'].version);
        expect(lock.packages['node_modules/passport-desktop-win32-x64-msvc'].version).toBe(NATIVE_PINS['passport-desktop'].version);
    });

    it('accepts the pinned bytes and nothing else', () => {
        const good = { module: 'keytar', version: '7.9.0', target: 'linux-x64', sha256: NATIVE_PINS.keytar.sha256['linux-x64'] };
        expect(checkNativeModule(good)).toEqual({ ok: true });
        expect(checkNativeModule({ ...good, sha256: 'ab'.repeat(32) }).ok).toBe(false);
        expect(checkNativeModule({ ...good, version: '7.9.1' }).ok).toBe(false);
        expect(checkNativeModule({ ...good, target: 'freebsd-x64' }).ok).toBe(false);
        expect(checkNativeModule({ ...good, module: 'something-else' }).ok).toBe(false);
        // A digest filed under another module must not pass for this one
        expect(checkNativeModule({ ...good, module: 'node-hid', version: '3.4.0' }).ok).toBe(false);
    });

    it('matches the binaries installed here', () => {
        for (const { module, file, target } of installed()) {
            const absolute = path.join(root, file);
            const pinned = NATIVE_PINS[module].sha256[target];
            if (!fs.existsSync(absolute) || !pinned) continue;
            expect(sha256(absolute), `${module} ${target}`).toBe(pinned);
        }
    });
});

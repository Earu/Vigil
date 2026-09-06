import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every native binary that ships outside app.asar is pinned by SHA-256 per
// platform; the copy step refuses anything else. These check the table
// itself: that it covers the release targets, names the versions the
// lockfile installs, and matches the binaries installed here

const { NATIVE_PINS, checkNativeModule } = await import('../electron/native-pins.mjs');
const { auditUnpacked, resourcesDir } = await import('../electron/verify-unpacked-natives.mjs');
const { OUTPUT_NAMES, OWN_ADDONS } = await import('../electron/native-names.mjs');

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

    it('names an output file for every module the copy step ships', () => {
        const copy = fs.readFileSync(path.join(root, 'electron', 'copy-native-modules.mjs'), 'utf8');
        const shipped = copy.match(/modulesToCopy = \[([^\]]*)\]/)![1].match(/'[^']+'/g)!.map(s => s.slice(1, -1));
        for (const module of [...shipped, 'passport-desktop']) expect(OUTPUT_NAMES[module], module).toMatch(/\.node$/);
    });
});

// The check that runs on the packaged app: the unpacked native binaries
// must be exactly the manifest's files with the pinned bytes, plus the
// addons built here, and nothing else
describe('packaged native binaries', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-unpacked-'));
    const unpackedRoot = path.join(scratch, 'app.asar.unpacked');
    const nativeDir = path.join(unpackedRoot, 'dist-electron');
    const good = Buffer.from('the pinned bytes');
    const manifest = {
        'argon2.node': { module: '@node-rs/argon2', version: '2.0.2', target: 'test-x64', sha256: sha256Of(good) },
    };
    // Stands in for the pin table: the manifest's digest is the pinned one
    const check = ({ module, version, target, sha256: digest }: { module: string; version: string; target: string; sha256: string }) =>
        module === '@node-rs/argon2' && version === '2.0.2' && target === 'test-x64' && digest === manifest['argon2.node'].sha256
            ? { ok: true }
            : { ok: false, reason: 'no such pin' };

    function sha256Of(data: Buffer): string {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    const reset = () => {
        fs.rmSync(unpackedRoot, { recursive: true, force: true });
        fs.mkdirSync(nativeDir, { recursive: true });
        fs.writeFileSync(path.join(nativeDir, 'argon2.node'), good);
    };

    afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

    it('passes a package holding exactly the pinned files and the addons built here', () => {
        reset();
        for (const addon of OWN_ADDONS) fs.writeFileSync(path.join(nativeDir, addon), 'compiled here');
        expect(auditUnpacked({ unpackedRoot, manifest, check })).toEqual([]);
    });

    it('fails a pinned file whose bytes changed after the copy step', () => {
        reset();
        fs.writeFileSync(path.join(nativeDir, 'argon2.node'), 'swapped after the check');
        const problems = auditUnpacked({ unpackedRoot, manifest, check });
        expect(problems).toHaveLength(1);
        expect(problems[0].file).toContain('argon2.node');
    });

    it('fails a pinned file that never made it into the package', () => {
        reset();
        fs.unlinkSync(path.join(nativeDir, 'argon2.node'));
        expect(auditUnpacked({ unpackedRoot, manifest, check })[0].reason).toContain('missing');
    });

    it('fails any other native binary in the package, wherever it sits', () => {
        reset();
        const stray = path.join(unpackedRoot, 'node_modules', 'keytar', 'build', 'Release');
        fs.mkdirSync(stray, { recursive: true });
        fs.writeFileSync(path.join(stray, 'keytar.node'), 'rebuilt by an install script');
        fs.writeFileSync(path.join(nativeDir, 'argon2.darwin-arm64.node'), 'left over from an older copy step');
        const problems = auditUnpacked({ unpackedRoot, manifest, check });
        expect(problems.map(problem => path.basename(problem.file)).sort()).toEqual(['argon2.darwin-arm64.node', 'keytar.node']);
        for (const problem of problems) expect(problem.reason).toContain('did not ship');
    });

    it('finds the resources directory for each platform layout', () => {
        expect(resourcesDir('/out/mac-arm64', 'darwin', 'Vigil')).toBe(path.join('/out/mac-arm64', 'Vigil.app', 'Contents', 'Resources'));
        expect(resourcesDir('/out/linux-unpacked', 'linux', 'Vigil')).toBe(path.join('/out/linux-unpacked', 'resources'));
        expect(resourcesDir('/out/win-unpacked', 'win32', 'Vigil')).toBe(path.join('/out/win-unpacked', 'resources'));
    });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import yaml from 'js-yaml';

// The hardening this app relies on is a handful of settings and conventions
// spread across the codebase, each one a single line away from being undone
// by a refactor. These pin them, at the source level, so undoing one fails
// the suite instead of shipping. Source-level on purpose: several of them
// (fuses, the CSP string, where ipcMain may be called) have no runtime
// surface a unit test could observe

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

function listFiles(dir: string, pattern: RegExp, out: string[] = []): string[] {
    for (const name of fs.readdirSync(path.join(root, dir))) {
        const rel = path.join(dir, name);
        if (name === 'node_modules' || name === 'native' || name === 'build') continue;
        if (fs.statSync(path.join(root, rel)).isDirectory()) listFiles(rel, pattern, out);
        else if (pattern.test(name)) out.push(rel);
    }
    return out;
}

const electronSources = listFiles('electron', /\.ts$/);
const rendererSources = listFiles('src', /\.tsx?$/);

describe('main process trust boundary', () => {
    it('every IPC channel is registered through the sender guard', () => {
        for (const file of electronSources) {
            if (file.endsWith('ipc-guard.ts')) continue;
            expect(read(file), file).not.toMatch(/\bipcMain\.(handle|on|once|handleOnce)\(/);
        }
        expect(read('electron/src/ipc-guard.ts')).toMatch(/ipcMain\.handle\(/);
        expect(read('electron/src/ipc-guard.ts')).toMatch(/ipcMain\.on\(/);
    });

    it('the renderer window is sandboxed, isolated, and cannot open DevTools when packaged', () => {
        const window = read('electron/src/window.ts');
        expect(window).toMatch(/nodeIntegration:\s*false/);
        expect(window).toMatch(/contextIsolation:\s*true/);
        expect(window).toMatch(/sandbox:\s*true/);
        expect(window).toMatch(/webSecurity:\s*true/);
        expect(window).toMatch(/allowRunningInsecureContent:\s*false/);
        expect(window).toMatch(/spellcheck:\s*false/);
        expect(window).toMatch(/devTools:\s*!app\.isPackaged/);
        expect(window).not.toMatch(/nodeIntegrationInSubFrames|webviewTag:\s*true|nodeIntegrationInWorker/);
        expect(window).toMatch(/setWindowOpenHandler\([^)]*\)\s*=>\s*\{?\s*return \{ action: 'deny' \}/s);
    });

    it('the packaged CSP allows no inline or eval script and no remote script host', () => {
        const window = read('electron/src/window.ts');
        // The production branch is the one after the dev ternary's colon
        const production = window.slice(window.indexOf(': "default-src \'self\';"'));
        const csp = production.slice(0, production.indexOf('frame-ancestors'));
        expect(csp).toContain("script-src 'self';");
        expect(csp).not.toMatch(/unsafe-inline'[^;]*;?\s*"\s*\+\s*"script-src|script-src[^;]*unsafe/);
        expect(csp).not.toMatch(/unsafe-eval/);
        expect(csp).not.toMatch(/script-src[^;]*https?:/);
        expect(csp).toContain("form-action 'none'");
        expect(csp).toContain("base-uri 'self'");
    });

    it('the packaged renderer loads from the app scheme, never from file:', () => {
        const window = read('electron/src/window.ts');
        expect(window).not.toMatch(/loadFile\(/);
        expect(window).toMatch(/win\.loadURL\(APP_INDEX_URL\)/);
        // Nothing in the production CSP may name file:, or 'self' stops
        // being the whole story
        const production = window.slice(window.indexOf(': "default-src \'self\';"'));
        expect(production.slice(0, production.indexOf('frame-ancestors'))).not.toMatch(/file:/);
        const guard = read('electron/src/ipc-guard.ts');
        expect(guard).toMatch(/APP_SCHEME/);
        expect(guard).not.toMatch(/'file:'/);
    });

    it('a packaged build refuses debugging switches before anything else runs', () => {
        const main = read('electron/app-main.ts');
        const refuse = main.indexOf('refuseDebugSwitches();');
        expect(refuse).toBeGreaterThan(0);
        expect(refuse).toBeLessThan(main.indexOf('requestSingleInstanceLock'));
        expect(refuse).toBeLessThan(main.indexOf('app.whenReady'));
        const guard = read('electron/src/launch-guard.ts');
        for (const name of ['remote-debugging-port', 'remote-debugging-pipe', 'browser-subprocess-path', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'user-data-dir', 'disable-web-security', 'proxy-server', 'ignore-certificate-errors', 'ssl-key-log-file']) {
            expect(guard).toContain(`'${name}'`);
        }
        expect(guard).toMatch(/if \(!app\.isPackaged\) return;/);
    });

    it('packaged builds block navigation and grant the page only clipboard permissions', () => {
        expect(read('electron/src/window.ts')).toMatch(/will-navigate[\s\S]*?if \(!isDevBuild\(\)\) \{\s*(\/\/[^\n]*\n\s*)*event\.preventDefault\(\)/);
        const main = read('electron/app-main.ts');
        expect(main).toMatch(/setPermissionRequestHandler/);
        expect(main).toMatch(/setPermissionCheckHandler/);
        const allowed = main.match(/allowedPermissions = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
        expect(allowed.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean).sort())
            .toEqual(['clipboard-read', 'clipboard-sanitized-write']);
    });

    it('the preload exposes wrappers, never ipcRenderer itself', () => {
        const preload = read('electron/preload.ts');
        const uses = preload.match(/\bipcRenderer\b(?!\.(invoke|on|off|send)\()/g) ?? [];
        // The import is the only bare mention allowed
        expect(uses).toHaveLength(1);
        expect(preload).toMatch(/^import \{[^}]*\bipcRenderer\b[^}]*\} from 'electron'/m);
        expect(preload).toMatch(/contextBridge\.exposeInMainWorld\('electron', api\)/);
        expect(preload).not.toMatch(/require\(|process\.|__dirname/);
    });

    it('opening a link from the vault goes through the scheme allowlist, nowhere else', () => {
        for (const file of [...electronSources, ...rendererSources]) {
            if (file.endsWith('electron/src/utils.ts')) continue;
            expect(read(file), file).not.toMatch(/shell\.openExternal\(/);
        }
        const utils = read('electron/src/utils.ts');
        const allowed = utils.match(/ALLOWED_PROTOCOLS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
        expect(allowed.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean).sort())
            .toEqual(['http:', 'https:', 'mailto:']);
    });

    it('screen capture requires a real gesture and hands the renderer text only', () => {
        const ipc = read('electron/src/ipc.ts');
        const body = ipc.slice(ipc.indexOf("handle('qr-capture-screens'"));
        // Up to the next channel registration: this handler has nested
        // callbacks, so the first '});' is not its end
        const handler = body.slice(0, body.indexOf('\n    handle('));
        expect(handler).toMatch(/consumeRecentGesture\(/);
        expect(handler).toMatch(/decodeQrFromImage\(/);
        expect(handler).not.toMatch(/toPNG|toDataURL|toJPEG|toBitmap/);
        expect(read('electron/src/window.ts')).toMatch(/trackGestures\(win\)/);
    });

    it('the log file is created owner-only', () => {
        expect(read('electron/src/logger.ts')).toMatch(/writeOptions = \{[^}]*mode: 0o600/);
    });

    it('path-taking IPC channels are gated on a grant', () => {
        const ipc = read('electron/src/ipc.ts');
        for (const channel of ['read-file', 'stat-file', 'save-to-file', 'get-biometric-password', 'enable-biometrics', 'disable-biometrics', 'has-biometrics-enabled', 'save-last-database-path', 'get-backup-info', 'reveal-backups', 'purge-backups', 'list-conflict-copies', 'trash-conflict-copy']) {
            const body = ipc.slice(ipc.indexOf(`handle('${channel}'`));
            const handler = body.slice(0, body.indexOf('});') + 3);
            expect(handler, channel).toMatch(/isPathGranted\(/);
        }
    });
});

describe('renderer', () => {
    it('renders no HTML from strings and evaluates no code', () => {
        for (const file of rendererSources) {
            expect(read(file), file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(|document\.write\(/);
        }
    });

    it('never logs vault contents through the error forwarder', () => {
        const reporting = read('src/errorReporting.ts');
        expect(reporting).not.toMatch(/JSON\.stringify/);
    });
});

describe('packaged build configuration', () => {
    const require = createRequire(__filename);
    const config = require(path.join(root, 'electron-builder.config.js'));

    it('sets every hardening fuse and keeps the asar sealed', () => {
        const fuses = config.electronFuses;
        expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(false);
        expect(fuses.enableNodeCliInspectArguments).toBe(false);
        expect(fuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
        expect(fuses.onlyLoadAppFromAsar).toBe(true);
        expect(fuses.enableCookieEncryption).toBe(true);
        expect(fuses.loadBrowserProcessSpecificV8Snapshot).toBe(false);
        // The renderer loads from vigil://app; file:// gets nothing extra
        expect(fuses.grantFileProtocolExtraPrivileges).toBe(false);
        // Windows is the one platform whose native messaging proxy needs it
        expect(fuses.runAsNode).toBe(process.platform === 'win32');
        expect(config.asar).toBe(true);
    });

    it('signs update metadata in a job of its own that installs nothing, and the release waits for it', () => {
        const release = yaml.load(read('.github/workflows/release.yml')) as {
            jobs: Record<string, { needs?: string | string[]; steps: Array<{ run?: string; uses?: string; env?: Record<string, string> }> }>;
        };
        const sign = release.jobs.sign;
        expect(sign).toBeDefined();
        const signStep = sign.steps.find(step => step.run?.includes('sign-update-metadata.mjs'));
        expect(signStep?.env?.UPDATE_SIGNING_KEY).toBeDefined();
        // The key never shares a process tree with third-party code: no
        // dependency install in this job, and no other job sees the secret
        for (const step of sign.steps) expect(step.run ?? '').not.toMatch(/npm (ci|install|i)\b|npx /);
        for (const [name, job] of Object.entries(release.jobs)) {
            if (name === 'sign') continue;
            expect(JSON.stringify(job), name).not.toContain('UPDATE_SIGNING_KEY');
        }
        expect([release.jobs.release.needs].flat()).toContain('sign');
        expect(read('electron/src/updater.ts')).toMatch(/autoUpdater\.autoDownload = false/);
        expect(read('electron/src/updater.ts')).toMatch(/UPDATE_PUBLIC_KEY = '[A-Za-z0-9+/=]{20,}'/);
    });

    it('never substitutes a workflow expression into a shell script', () => {
        for (const file of listFiles('.github/workflows', /\.ya?ml$/)) {
            const workflow = yaml.load(read(file)) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
            for (const job of Object.values(workflow.jobs)) {
                for (const step of job.steps) {
                    // Values reach a script through env, where the shell
                    // quotes them; substituted into the script they are code
                    expect(step.run ?? '', file).not.toMatch(/\$\{\{/);
                }
            }
        }
    });

    it('ships a native binary only when it matches its pin, and no workflow opts out', () => {
        const copy = read('electron/copy-native-modules.mjs');
        // Every module in the copy loop goes through the check, unconditionally
        expect(copy).toMatch(/for \(const moduleName of modulesToCopy\) \{\s*try \{\s*const located = locateModule\(moduleName\);\s*verifyPinned\(moduleName, located\);/);
        for (const file of listFiles('.github/workflows', /\.ya?ml$/)) {
            expect(read(file), file).not.toContain('VIGIL_ALLOW_UNPINNED_NATIVE');
        }
    });

    it('pins every workflow action to a commit', () => {
        for (const file of listFiles('.github/workflows', /\.ya?ml$/)) {
            // The key itself, not a word ending in "uses:" inside a run script
            const uses = read(file).match(/^\s*-?\s*uses:\s*\S+/gm) ?? [];
            for (const line of uses) expect(line, `${file}: ${line}`).toMatch(/@[0-9a-f]{40}$/);
        }
    });
});

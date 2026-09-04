import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The packaged renderer is served from vigil://app by a handler that reads
// files out of dist/. The handler is the one place a request URL turns into
// a filesystem path, so it must not be talked into serving anything else

const handlers = new Map<string, (request: { url: string }) => Promise<Response>>();
const privileged: unknown[] = [];

vi.mock('electron', () => ({
    app: { getAppPath: () => '/opt/vigil/app' },
    protocol: {
        handle: (scheme: string, fn: (request: { url: string }) => Promise<Response>) => { handlers.set(scheme, fn); },
        registerSchemesAsPrivileged: (schemes: unknown[]) => { privileged.push(...schemes); },
    },
}));

const { resolveAppFile, contentTypeFor, installAppProtocol, registerAppScheme, APP_INDEX_URL } =
    await import('../electron/src/app-protocol');

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-dist-'));
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
fs.writeFileSync(path.join(path.dirname(dist), 'outside.txt'), 'not yours');

afterAll(() => {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(dist), 'outside.txt'), { force: true });
});

describe('resolveAppFile', () => {
    const index = path.join(dist, 'index.html');

    it('maps the document and its assets to files under dist', () => {
        expect(resolveAppFile(APP_INDEX_URL, dist)).toBe(index);
        expect(resolveAppFile('vigil://app/', dist)).toBe(index);
        expect(resolveAppFile('vigil://app/index.html#/entries?x=1', dist)).toBe(index);
        expect(resolveAppFile('vigil://app/assets/app.js', dist)).toBe(path.join(dist, 'assets', 'app.js'));
    });

    it('never resolves outside dist', () => {
        // The URL parser folds dot segments at the root, so these stay
        // under dist rather than climbing out of it
        for (const url of ['vigil://app/../outside.txt', 'vigil://app/assets/../../outside.txt', 'vigil://app/%2e%2e/outside.txt']) {
            expect(resolveAppFile(url, dist), url).toBe(path.join(dist, 'outside.txt'));
        }
        // Encoded separators only become '..' segments after parsing, in
        // the decode this handler does itself; that is the climb it must
        // refuse
        expect(resolveAppFile('vigil://app/..%2foutside.txt', dist)).toBeNull();
        expect(resolveAppFile('vigil://app/assets/..%2f..%2foutside.txt', dist)).toBeNull();
        expect(resolveAppFile('vigil://app/index.html%00.txt', dist)).toBeNull();
        // Folded to the root by the parser, so the document
        expect(resolveAppFile('vigil://app/assets/..', dist)).toBe(index);
    });

    it('serves only its own host and scheme', () => {
        expect(resolveAppFile('vigil://other/index.html', dist)).toBeNull();
        expect(resolveAppFile('vigil://app.evil/index.html', dist)).toBeNull();
        expect(resolveAppFile('file:///etc/passwd', dist)).toBeNull();
        expect(resolveAppFile('https://app/index.html', dist)).toBeNull();
        expect(resolveAppFile('not a url', dist)).toBeNull();
    });
});

describe('contentTypeFor', () => {
    it('names the types dist contains and falls back to octet-stream', () => {
        expect(contentTypeFor('index.html')).toMatch(/^text\/html/);
        expect(contentTypeFor('a.js')).toMatch(/^text\/javascript/);
        expect(contentTypeFor('a.css')).toMatch(/^text\/css/);
        expect(contentTypeFor('a.woff2')).toBe('font/woff2');
        expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
        expect(contentTypeFor('a.unknown')).toBe('application/octet-stream');
    });
});

describe('the handler', () => {
    it('answers with the file, its type, and 404 for everything else', async () => {
        installAppProtocol(dist);
        const handler = handlers.get('vigil')!;
        const ok = await handler({ url: 'vigil://app/assets/app.js' });
        expect(ok.status).toBe(200);
        expect(ok.headers.get('content-type')).toMatch(/^text\/javascript/);
        expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await ok.text()).toBe('console.log(1)');

        expect((await handler({ url: 'vigil://app/missing.js' })).status).toBe(404);
        expect((await handler({ url: 'vigil://app/../outside.txt' })).status).toBe(404);
        expect((await handler({ url: 'vigil://app/assets' })).status).toBe(404);
    });

    it('registers a standard, secure scheme with no CSP bypass or service workers', () => {
        registerAppScheme();
        expect(privileged).toEqual([{
            scheme: 'vigil',
            privileges: expect.objectContaining({ standard: true, secure: true }),
        }]);
        const { privileges } = privileged[0] as { privileges: Record<string, unknown> };
        expect(privileges.bypassCSP).toBeUndefined();
        expect(privileges.allowServiceWorkers).toBeUndefined();
    });
});

import { app, protocol } from 'electron';
import fs from 'fs';
import path from 'path';

// The packaged renderer is served from here rather than from a file://
// document. A file: page is same-origin with every other file: URL, so a
// renderer bug that got script running could fetch() any file the user can
// read, past the path grants in path-authority. Under its own scheme the
// document's origin is exactly this host: 'self' in the CSP means files
// under dist/ and nothing else, and file: is a foreign origin the CSP
// refuses.
//
// standard: the origin is a real (non-opaque) one, which is what gives the
// page localStorage and lets module scripts load as same-origin. secure: a
// secure context, which crypto.subtle needs. Nothing else: no CSP bypass, no
// service workers
export const APP_SCHEME = 'vigil';
export const APP_HOST = 'app';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

// Must run before app.whenReady resolves
export function registerAppScheme(): void {
    protocol.registerSchemesAsPrivileged([{
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    }]);
}

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.wasm': 'application/wasm',
};

export function contentTypeFor(file: string): string {
    return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// The file under distDir a request names, or null for anything else: another
// host, a path that climbs out of distDir, the directory itself, a NUL byte.
// Exported for tests
export function resolveAppFile(url: string, distDir: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST) return null;
    let pathname: string;
    try {
        pathname = decodeURIComponent(parsed.pathname);
    } catch {
        return null;
    }
    if (pathname.includes('\0')) return null;
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const root = path.resolve(distDir);
    // resolve() folds every '..' before the prefix check sees the result
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) return null;
    return file;
}

export function installAppProtocol(distDir: string = path.join(app.getAppPath(), 'dist')): void {
    protocol.handle(APP_SCHEME, async (request) => {
        const file = resolveAppFile(request.url, distDir);
        if (!file) return new Response('Not found', { status: 404 });
        try {
            const data = await fs.promises.readFile(file);
            return new Response(data, {
                status: 200,
                headers: { 'content-type': contentTypeFor(file), 'x-content-type-options': 'nosniff' },
            });
        } catch {
            return new Response('Not found', { status: 404 });
        }
    });
}

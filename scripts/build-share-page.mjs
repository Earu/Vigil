// Builds the hosted share page from the same source the app builds share files
// from, so the two cannot drift. The only difference between them is where the
// blob comes from: a file carries it inline, this reads it out of the URL
// fragment, which browsers never send to a server.
//
// Writes <root>/share/index.html, so the page is served at /share/.
//
//   node scripts/build-share-page.mjs [siteRoot]   (default: docs)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const root = path.resolve(process.argv[2] ?? path.join(REPO, 'docs'));
const out = path.join(root, 'share');

const bundle = await esbuild.build({
    entryPoints: [path.join(REPO, 'src/services/sharePage.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'error',
});

const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const digest = async text => `sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}`;
const html = await module.buildPage(module.FRAGMENT_BLOB, digest);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
// Pages would otherwise run the whole directory through Jekyll
fs.writeFileSync(path.join(root, '.nojekyll'), '');

console.log(`${path.join(out, 'index.html')}  ${(html.length / 1024).toFixed(1)} KB`);

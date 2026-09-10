// What ships as the hosted share page is what someone types a code into, so
// this checks the built file against the properties the format depends on
// rather than trusting the build that just ran.
//
//   node scripts/check-share-page.mjs _site/share/index.html

import crypto from 'node:crypto';
import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Pass the path to the built page');
const html = fs.readFileSync(file, 'utf8');

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const digest = value => `sha256-${crypto.createHash('sha256').update(value, 'utf8').digest('base64')}`;

check(csp.includes("default-src 'none'"), 'the page may reach the network');
check(csp.includes(`script-src '${digest(script)}'`), 'the script does not match the hash pinning it');
check(csp.includes(`style-src '${digest(style)}'`), 'the stylesheet does not match the hash pinning it');
check(csp.includes("base-uri 'none'") && csp.includes("form-action 'none'"), 'base-uri and form-action are not pinned');

// One inline classic script and nothing fetched: ES modules never execute from
// a file:// copy of this same page, and a share carries no network access
check(!/<script[^>]+src=/i.test(html), 'the page loads a script from somewhere else');
check(!/<link[^>]+href=/i.test(html), 'the page loads a stylesheet from somewhere else');
check((html.match(/<script/g) ?? []).length === 1, 'the page has more than one script');
check(!/\bfetch\s*\(|XMLHttpRequest|import\s*\(/.test(script), 'the script tries to fetch something');
check(!/\.innerHTML|document\.write/.test(script), 'the script writes markup rather than text');

// The share rides in the fragment, which browsers never send to a server
check(script.includes('location.hash'), 'the page does not read the share from the fragment');
check(!/location\.search|URLSearchParams/.test(script), 'the page reads the share from the query string');

// A hosted page carries no share of its own
check(!/var BLOB = \{/.test(script), 'the page has a share baked into it');

if (failures.length > 0) {
    console.error(`${file}\n${failures.map(text => `  - ${text}`).join('\n')}`);
    process.exit(1);
}

console.log(`${file}  ${(html.length / 1024).toFixed(1)} KB, ${failures.length === 0 ? 'as expected' : ''}`);

// Regenerates src/fonts from Google Fonts. Run from src/fonts:
//     cd src/fonts && node ../../scripts/fetch-fonts.mjs
//
// Vigil self-hosts its fonts so the app makes no network request on launch and
// renders correctly offline. This fetches the same subsets Google would serve,
// keeping their unicode-range declarations, and rewrites each src: to the local
// file. See src/fonts/README.md.

import { writeFileSync } from 'fs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SHEETS = [
    'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
];
const KEEP = new Set(['latin', 'latin-ext']);

let out = `/* Inter and Bebas Neue, self-hosted. Generated; see README.md.
   Both are variable fonts: one file per subset backs every weight, which is
   why the weight-500/600/700 faces below point at the same file as 400. That
   is exactly what Google Fonts serves, so rendering is unchanged.
   SIL Open Font License 1.1, see OFL.txt. */
`;

const files = new Map(); // remote url -> local filename

for (const sheet of SHEETS) {
    const css = await fetch(sheet, { headers: { 'User-Agent': UA } }).then(r => r.text());
    const blocks = css.split(/\/\* ([a-z0-9-]+) \*\//i).slice(1);
    for (let i = 0; i < blocks.length; i += 2) {
        const [subset, block] = [blocks[i], blocks[i + 1]];
        if (!KEEP.has(subset)) continue;
        const url = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
        const family = block.match(/font-family:\s*'([^']+)'/)?.[1];
        if (!url || !family) continue;

        let name = files.get(url);
        if (!name) {
            name = `${family.replace(/\s+/g, '')}-${subset}.woff2`;
            const bytes = Buffer.from(await fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.arrayBuffer()));
            writeFileSync(name, bytes);
            files.set(url, name);
            console.error(`downloaded ${name}  ${(bytes.length / 1024).toFixed(1)} KB`);
        }
        out += block.replace(/src:\s*url\([^)]+\)\s*format\('woff2'\)/, `src: url('./${name}') format('woff2')`);
    }
}
writeFileSync('fonts.css', out);
console.error(`\n${files.size} files, ${(out.match(/@font-face/g) || []).length} @font-face rules`);

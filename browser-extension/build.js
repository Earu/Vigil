import * as esbuild from 'esbuild';
import fs from 'fs';
const watch = process.argv.includes('--watch');
const manifest = process.argv.includes('--chrome') ? 'manifest.chrome.json' : 'manifest.firefox.json';

function copyIcons() {
    if (!fs.existsSync('dist/icons')) {
        fs.mkdirSync('dist/icons', { recursive: true });
    }
    
    ['16', '32', '48', '128'].forEach(size => {
        fs.copyFileSync(
            `../build/icons/icon_${size}x${size}.png`,
            `dist/icons/icon${size}.png`
        );
    });
}

const config = {
    entryPoints: [
        'background.ts',
        'content.ts',
        'popup/popup.ts'
    ],
    bundle: true,
    outdir: 'dist',
    platform: 'browser',
    target: ['chrome58', 'firefox57'],
    format: 'iife',
    sourcemap: 'both',
    minify: false,
    logLevel: 'info',
    define: {
        'process.env.NODE_ENV': '"development"'
    }
};

console.log("using manifest", manifest);
fs.copyFileSync(manifest, 'manifest.json');
fs.copyFileSync(manifest, 'dist/manifest.json');
fs.copyFileSync('popup/popup.html', 'dist/popup/popup.html');

copyIcons();

if (watch) {
    const context = await esbuild.context(config);
    await context.watch();
    console.log('Watching for changes...');
} else {
    await esbuild.build(config);
    console.log('Build complete');
}
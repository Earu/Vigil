import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

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

if (watch) {
    const context = await esbuild.context(config);
    await context.watch();
    console.log('Watching for changes...');
} else {
    await esbuild.build(config);
    console.log('Build complete');
} 
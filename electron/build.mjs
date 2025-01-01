import * as esbuild from 'esbuild';

const config = {
	platform: 'node',
	entryPoints: ['electron/main.ts', 'electron/preload.ts'],
	bundle: true,
	outdir: 'dist-electron',
	external: [
		'electron',
		'keytar',
		'sqlite3',
		// Exclude all .node files
		'*.node',
		// Exclude native modules
		'@node-rs/argon2-win32-x64-msvc',
		'@node-rs/argon2',
		'passport-desktop',
		'passport-desktop-win32-x64-msvc'
	],
	format: 'cjs',
	target: 'node18',
	sourcemap: true,
	minify: process.env.NODE_ENV !== 'development'
};

try {
	await esbuild.build(config);
} catch (err) {
	console.error('Build failed:', err);
	process.exit(1);
}
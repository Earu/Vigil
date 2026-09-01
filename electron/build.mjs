import * as esbuild from 'esbuild';

const config = {
	platform: 'node',
	// main.ts is a shim that requires one of the other two at runtime; they
	// are separate outputs, not bundled into it, so the branch not taken is
	// never loaded (see the comment at the top of electron/main.ts)
	entryPoints: ['electron/main.ts', 'electron/app-main.ts', 'electron/browser-proxy.ts', 'electron/preload.ts'],
	bundle: true,
	outdir: 'dist-electron',
	external: [
		// Resolved at runtime from dist-electron/, where both land
		'./app-main',
		'./browser-proxy',
		'electron',
		'keytar',
		'node-hid',
		// Exclude all .node files
		'*.node',
		// Exclude native modules
		'@node-rs/argon2-win32-x64-msvc',
		'@node-rs/argon2',
		'passport-desktop',
		'passport-desktop-win32-x64-msvc'
	],
	format: 'cjs',
	target: 'node22',
	sourcemap: true,
	minify: process.env.NODE_ENV !== 'development'
};

try {
	await esbuild.build(config);
} catch (err) {
	console.error('Build failed:', err);
	process.exit(1);
}
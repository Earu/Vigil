import * as esbuild from 'esbuild'

const config = {
	platform: 'node',
	entryPoints: ['electron/main.ts', 'electron/preload.ts'],
	bundle: true,
	outdir: 'dist-electron',
	external: [
		'electron',
		// Add native modules here
		'keytar'
	],
	format: 'cjs',
	target: 'node18',
	sourcemap: true,
	minify: process.env.NODE_ENV !== 'development'
}

try {
	await esbuild.build(config)
} catch (err) {
	console.error('Build failed:', err)
	process.exit(1)
}
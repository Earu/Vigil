import * as esbuild from 'esbuild'
import path from 'path'

const config = {
	platform: 'node',
	entryPoints: ['electron/main.ts', 'electron/preload.ts'],
	bundle: true,
	outdir: 'dist-electron',
	external: [
		'electron',
		'keytar',
		// Exclude all .node files
		'*.node',
		// Exclude the windows_hello binding
		'../native/windows_hello/*'
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
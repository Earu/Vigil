import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version)
	},
	plugins: [
		wasm(),
		react()
	],
	build: {
		// Electron's Chromium supports top-level await natively; the
		// vite-plugin-top-level-await transform is unneeded at this target
		// and its current @swc/core crashes the build
		target: 'esnext',
		outDir: 'dist',
		rollupOptions: {
			external: [
				/\.wasm$/,
				/\.node$/,
				'keytar',
				'@node-rs/argon2',
			],
		},
		assetsDir: 'assets'
	},
	optimizeDeps: {
		exclude: ['@syntect/wasm', '@node-rs/argon2', 'keytar']
	},
	base: './'
})

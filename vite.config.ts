import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
	plugins: [
		wasm(),
		topLevelAwait(),
		react()
	],
	build: {
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

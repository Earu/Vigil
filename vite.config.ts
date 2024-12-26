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
			external: [/\.wasm$/],
		},
		assetsDir: 'assets'
	},
	optimizeDeps: {
		exclude: ['@syntect/wasm', 'argon2-browser']
	},
	base: './'
})

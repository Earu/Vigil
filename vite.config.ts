import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
	plugins: [react()],
	base: './',
	optimizeDeps: {
		exclude: ['argon2-browser']
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'index.html')
			}
		},
		assetsDir: 'assets',
		target: 'esnext'
	},
	server: {
		fs: {
			strict: false
		}
	},
	resolve: {
		alias: {
			'argon2-browser': resolve(__dirname, 'node_modules/argon2-browser')
		}
	}
})

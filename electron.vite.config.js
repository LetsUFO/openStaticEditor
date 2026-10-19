const { resolve } = require('node:path');
const { defineConfig, externalizeDepsPlugin } = require('electron-vite');
const vue = require('@vitejs/plugin-vue');
const tailwindcss = require('@tailwindcss/vite').default;

module.exports = defineConfig({
	main: {
		build: {
			lib: {
				entry: 'electron/main/index.js'
			}
		},
		plugins: [externalizeDepsPlugin()]
	},
	preload: {
		build: {
			lib: {
				entry: 'electron/preload/index.js'
			}
		},
		plugins: [externalizeDepsPlugin()]
	},
	renderer: {
		root: 'src',
		build: {
			rollupOptions: {
				input: resolve(process.cwd(), 'src/index.html')
			}
		},
		resolve: {
			alias: {
				'@renderer': resolve('src')
			}
		},
		plugins: [vue(), tailwindcss()]
	}
});

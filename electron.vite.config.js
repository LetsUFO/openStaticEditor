const { resolve } = require('node:path')
const { defineConfig, externalizeDepsPlugin } = require('electron-vite')
const vue = require('@vitejs/plugin-vue')

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
		root: 'src/renderer',
		resolve: {
			alias: {
				'@renderer': resolve('src/renderer')
			}
		},
		plugins: [vue()]
	}
})

const { resolve } = require('node:path');
const { defineConfig, externalizeDepsPlugin } = require('electron-vite');
const vue = require('@vitejs/plugin-vue');
// Tailwind v4 走 PostCSS 而非 Vite 插件：
// @tailwindcss/vite 内部只匹配 .css（源码里全是 .css$/、.css(?:\?.*，无 scss），
// 用 .scss 入口时它会被完全跳过、Tailwind 指令原样残留。
// PostCSS 在 Sass 编译之后运行，因此 .scss 与 .css 都能接管。
const tailwindPostcss = require('@tailwindcss/postcss');

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
		css: {
			postcss: {
				plugins: [tailwindPostcss]
			}
		},
		plugins: [vue()]
	}
});

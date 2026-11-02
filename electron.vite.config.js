const { resolve } = require('node:path');
const { defineConfig, externalizeDepsPlugin } = require('electron-vite');
const vue = require('@vitejs/plugin-vue');
const buildIcons = require('./scripts/build-icons');
// Tailwind v4 走 PostCSS 而非 Vite 插件：
// @tailwindcss/vite 内部只匹配 .css（源码里全是 .css$/、.css(?:\?.*，无 scss），
// 用 .scss 入口时它会被完全跳过、Tailwind 指令原样残留。
// PostCSS 在 Sass 编译之后运行，因此 .scss 与 .css 都能接管。
const tailwindPostcss = require('@tailwindcss/postcss');

// 所有 electron-vite build（build / package / dist / build:win / build:mac …）
// 都会经过这里，打包图标（build/icon.ico、build/icon.icns）因此自动生成。
const iconsPlugin = {
	name: 'openstaticeditor-icons',
	apply: 'build',
	async buildStart() {
		await buildIcons();
	}
};

module.exports = defineConfig({
	main: {
		build: {
			lib: {
				entry: 'electron/main/index.js'
			}
		},
		plugins: [externalizeDepsPlugin(), iconsPlugin]
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

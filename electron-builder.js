/**
 * electron-builder 配置（JS 形式，便于按 custom/config.json 动态计算版本）。
 * 注意：package.json 若存在 "build" 字段会优先于本文件，因此配置只保留在这里。
 * 产物目录与安装包文件名里的版本号统一用 custom/config.json 的 ver。
 */
const { getCustomMeta } = require('./scripts/custom-meta');

const { ver } = getCustomMeta();

module.exports = {
	appId: 'openstaticeditor',
	productName: 'OpenStaticEditor',
	copyright: "Copyright © 2026 Let's UFO",
	directories: {
		output: `release/${ver}`
	},
	files: ['out/**/*'],
	extraResources: [
		{
			from: 'custom',
			to: 'custom'
		}
	],
	mac: {
		target: ['dmg'],
		artifactName: `\${productName}-${ver}-mac.\${ext}`
	},
	win: {
		target: ['nsis'],
		artifactName: `\${productName}-${ver}-setup.\${ext}`
	},
	nsis: {
		oneClick: false,
		perMachine: false,
		allowToChangeInstallationDirectory: true,
		createDesktopShortcut: true
	}
};

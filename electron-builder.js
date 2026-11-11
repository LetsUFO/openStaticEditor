/**
 * electron-builder 配置（JS 形式）。
 * 注意：package.json 若存在 "build" 字段会优先于本文件，因此配置只保留在这里。
 * 产物目录、安装包文件名、productName 统一使用 package.json 的 name + 带 v 前缀的版本（v0.4.0）。
 * package.json 的 version 本身是纯 semver，v 前缀由 scripts/custom-meta.js 统一补齐。
 */
const { getCustomMeta } = require('./scripts/custom-meta');

const { name, ver } = getCustomMeta();

module.exports = {
	appId: 'openstaticeditor',
	productName: name,
	copyright: "Copyright © 2026 Let's UFO",
	directories: {
		output: `release/${ver}`
	},
	files: ['out/**/*'],
	extraResources: [
		{
			from: 'custom',
			to: 'custom',
			filter: ['**/*', '!_*', '!_*/**']
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

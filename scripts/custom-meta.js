/**
 * 构建产物元信息：name 与 ver 统一从 package.json 读取。
 * electron-builder 配置与 scripts/organize-release.js 共用，保证口径一致。
 */
const { name: pkgName, version: pkgVersion } = require('../package.json');

function getCustomMeta() {
	return { name: pkgName, ver: pkgVersion };
}

module.exports = { getCustomMeta };

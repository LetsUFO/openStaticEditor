/**
 * 构建产物元信息：name 与 ver 统一从 package.json 读取。
 * electron-builder 配置与 scripts/organize-release.js 共用，保证口径一致。
 *
 * package.json 的 version 必须是纯 semver（0.4.0），供 npm / electron-builder 正确解析。
 * 但界面展示、产物目录、安装包文件名、窗口标题一律带 "v" 前缀（v0.4.0），
 * 这个前缀在本文件统一补齐，所有下游拿到的 ver 都是带 v 的，不要在调用处重复拼接。
 */
const { name: pkgName, version: pkgVersion } = require('../package.json');

function getCustomMeta() {
	return { name: pkgName, ver: `v${pkgVersion}`, semver: pkgVersion };
}

module.exports = { getCustomMeta };

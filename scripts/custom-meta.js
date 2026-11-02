/**
 * 读取 custom/config.json 的对外元信息（名称、版本）。
 * ver 缺省时回退 package.json version，name 缺省时回退空串。
 * electron-builder 配置与 scripts/organize-release.js 共用，保证版本口径一致。
 */
const { version: pkgVersion } = require('../package.json');

function getCustomMeta() {
	let name = '';
	let ver = pkgVersion;
	try {
		const config = require('../custom/config.json');
		if (typeof config.name === 'string') name = config.name.trim();
		if (typeof config.ver === 'string' && config.ver.trim()) ver = config.ver.trim();
	} catch (error) {
		console.warn(`[custom-meta] 读取 custom/config.json 失败，回退 package.json version：${error.message}`);
	}
	return { name, ver };
}

module.exports = { getCustomMeta };

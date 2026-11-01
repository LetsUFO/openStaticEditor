/**
 * 构建后整理产物目录：
 * release/<version>/win-unpacked   -> release/<version>/win
 * release/<version>/mac-arm64      -> release/<version>/mac
 * release/<version>/mac            -> release/<version>/mac
 *
 * 仅处理当前 package.json 的 version 目录，其它文件（如安装包）保持不动。
 */
const { existsSync, readdirSync, renameSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');

const { version } = require('../package.json');
const releaseDir = resolve(__dirname, '..', 'release', version);

// electron-builder 的 dir 目标目录名：win-unpacked / win-arm64-unpacked / mac / mac-arm64 / mac-universal
const RULES = [
	{ target: 'win', pattern: /^win(?:-\w+)?-unpacked$/ },
	{ target: 'mac', pattern: /^mac(?:-\w+)?$/ }
];

if (!existsSync(releaseDir)) {
	console.log(`[organize] 未找到 ${releaseDir}，跳过`);
	process.exit(0);
}

const moved = new Set();

for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;

	const rule = RULES.find((item) => item.pattern.test(entry.name));
	if (!rule) continue;

	const from = join(releaseDir, entry.name);
	const to = join(releaseDir, rule.target);
	if (from === to) continue;

	if (moved.has(rule.target)) {
		console.warn(`[organize] ${entry.name} 未处理：${rule.target} 已由同平台的另一个目录占用`);
		continue;
	}

	if (existsSync(to)) rmSync(to, { recursive: true, force: true });
	renameSync(from, to);
	moved.add(rule.target);
	console.log(`[organize] ${entry.name} -> ${rule.target}`);
}

/**
 * 构建后整理产物目录（版本号统一用 custom/config.json 的 ver）：
 * release/<ver>/win-unpacked   -> release/<ver>/<custom/config.json name> v<ver>
 * release/<ver>/mac-arm64      -> release/<ver>/mac
 * release/<ver>/mac            -> release/<ver>/mac
 *
 * 仅处理当前 ver 目录，其它文件（如安装包）保持不动。
 */
const { existsSync, readdirSync, renameSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { getCustomMeta } = require('./custom-meta');

const { name: configName, ver: version } = getCustomMeta();
const releaseDir = resolve(__dirname, '..', 'release', version);

const winTarget = configName ? `${configName} v${version}` : 'win';

// electron-builder 的 dir 目标目录名：win-unpacked / win-arm64-unpacked / mac / mac-arm64 / mac-universal
const RULES = [
	{ target: winTarget, pattern: /^win(?:-\w+)?-unpacked$/ },
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

// macOS 的 .app 名称由 productName 决定，这里按 config.json 的 name + ver 重命名，
// 并同步 Info.plist 里的 CFBundleName / CFBundleDisplayName（重命名 bundle 不会自动更新这两个键）。
const macDir = join(releaseDir, 'mac');

if (configName && existsSync(macDir)) {
	const appName = `${configName} v${version}`;

	for (const entry of readdirSync(macDir)) {
		if (!entry.endsWith('.app')) continue;

		const from = join(macDir, entry);
		const to = join(macDir, `${appName}.app`);
		if (from === to) continue;

		const plistPath = join(from, 'Contents', 'Info.plist');
		if (existsSync(plistPath)) {
			for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
				try {
					execFileSync('plutil', ['-replace', key, '-string', appName, plistPath]);
				} catch (error) {
					console.warn(`[organize] 更新 ${key} 失败：${error.message}`);
				}
			}
		}

		if (existsSync(to)) rmSync(to, { recursive: true, force: true });
		renameSync(from, to);
		console.log(`[organize] ${entry} -> ${appName}.app`);
	}
}

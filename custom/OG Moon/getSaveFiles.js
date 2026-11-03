#!/usr/bin/env node
/*
 * getSaveFiles.js — 列出指定目录下所有 .sav 存档文件
 * =====================================================
 * 纯 Node（仅内置 fs / path，无需安装依赖）。
 *
 * 用法：
 *   node getSaveFiles.js                          # 使用示例目录（见 DEFAULT_DIR）
 *   node getSaveFiles.js "C:\path\to\SaveGames"    # 传入目录
 *
 * 输出：一个字符串数组（Array<string>），元素为「完整文件名（含扩展名）」：
 *   [
 *     "ufo.sav",
 *     "test_AUTO_001.sav"
 *   ]
 */

'use strict';
const fs = require('fs');
const path = require('path');

// 示例目录（用户提供的 ES2 存档路径）
const DEFAULT_DIR = 'C:/Users/Azrael/AppData/Local/ES2/Saved/SaveGames';

function getSaveFiles(dir) {
	if (!fs.existsSync(dir)) {
		throw new Error('目录不存在: ' + dir);
	}
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const result = [];
	for (const e of entries) {
		if (!e.isFile()) continue;
		const ext = path.extname(e.name); // 含前导点，如 ".sav"
		if (ext.toLowerCase() !== '.sav') continue;
		result.push(e.name); // 完整文件名（含扩展名）
	}
	// 按文件名排序，便于阅读
	result.sort((a, b) => a.localeCompare(b));
	return result;
}

function main() {
	const dir = process.argv[2] || DEFAULT_DIR;
	let files;
	try {
		files = getSaveFiles(dir);
	} catch (e) {
		console.error('错误: ' + (e.message || e));
		process.exit(1);
	}
	console.log(JSON.stringify(files, null, 2));
	console.log(`\n共 ${files.length} 个 .sav 文件，目录: ${dir}`);
}

/**
 * 应用内调用入口（主进程 script:run 把本模块当函数调用）。
 * ctx.filePath —— 渲染进程解析 %user% 等简写后的存档目录绝对路径
 * 返回 .sav 文件名数组（供 LoadFile 下拉选择）
 */
function run(ctx = {}) {
	const dir = ctx.filePath || DEFAULT_DIR;
	return getSaveFiles(dir);
}

if (require.main === module) {
	main();
}

module.exports = run;
module.exports.getSaveFiles = getSaveFiles;

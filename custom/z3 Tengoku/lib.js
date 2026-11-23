'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 递归收集 dir 下所有指定文件的绝对路径。
 * 目录不可读（不存在 / 无权限）时当作无匹配继续，最终由数量校验统一报错。
 */
function findTargets(dir, targetName, results) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			findTargets(full, targetName, results);
		} else if (entry.isFile() && entry.name.toLowerCase() === targetName) {
			results.push(full);
		}
	}
}

/**
 * 在用户输入的目录中定位唯一的目标文件，也支持直接传入目标文件路径。
 * @param {string} filePath 用户输入的目录或文件路径
 * @param {string} fileName 要查找的完整文件名
 * @returns {string} 目标文件路径
 */
module.exports = function findFile(filePath, fileName) {
	const errorMessage = `请重新选择正确的目录，里面应该只包含一个${fileName}文件`;
	const input = typeof filePath === 'string' ? filePath.trim().replace(/^"+|"+$/g, '') : '';
	if (!input) throw new Error(errorMessage);

	const targetName = fileName.toLowerCase();
	const normalizedPath = path.normalize(input);
	let stat;
	try {
		stat = fs.statSync(normalizedPath);
	} catch {
		throw new Error(errorMessage);
	}

	if (stat.isFile()) {
		if (path.basename(normalizedPath).toLowerCase() === targetName) return normalizedPath;
		throw new Error(errorMessage);
	}
	if (!stat.isDirectory()) throw new Error(errorMessage);

	const found = [];
	findTargets(normalizedPath, targetName, found);
	// 0 个（没找到）或多个（目录不对 / 含多份）都视为目录选择有误
	if (found.length !== 1) throw new Error(errorMessage);
	return found[0];
};

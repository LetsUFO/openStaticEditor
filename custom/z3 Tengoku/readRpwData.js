'use strict';
/**
 * 第3次超级机器人大战Z：天狱篇 —— RPW_DATA.CPK 读取脚本
 *
 * 由主进程 file:read 调用（config.json -> loadFiles.RPW_DATA.readScript）。
 * 当前阶段只做第一步：从 ctx.filePath（用户在加载页选择的游戏目录）里查找 RPW_DATA.CPK，
 * 找到的唯一文件绝对路径即作为返回结果；后续解析动作待补充。
 *
 * ctx.filePath 可能来自界面手动输入，斜杠方向不确定，统一交给 path.normalize 归一。
 * 查找结果必须恰好 1 个：没找到或找到多个都视为目录选错，抛错提示重新选择。
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET_NAME = 'rpw_data.cpk';
const ERROR_MESSAGE = '请重新选择正确的游戏目录，里面因该只包含一个RPW_DATA.CPK文件';

/**
 * 递归收集 dir 下所有 RPW_DATA.CPK 的绝对路径。
 * 目录不可读（不存在 / 无权限）时当作无匹配继续，最终由数量校验统一报错。
 */
function findTargets(dir, results) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			findTargets(full, results);
		} else if (entry.isFile() && entry.name.toLowerCase() === TARGET_NAME) {
			results.push(full);
		}
	}
}

/**
 * @param {{ filePath?: string }} ctx 主进程注入的上下文
 * @returns {string} RPW_DATA.CPK 的绝对路径
 */
module.exports = function (ctx = {}) {
	const input = typeof ctx.filePath === 'string' ? ctx.filePath.trim().replace(/^"+|"+$/g, '') : '';
	if (!input) throw new Error(ERROR_MESSAGE);

	const dir = path.normalize(input);
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(ERROR_MESSAGE);

	const found = [];
	findTargets(dir, found);

	if (found.length !== 1) throw new Error(ERROR_MESSAGE);
	return found[0];
};

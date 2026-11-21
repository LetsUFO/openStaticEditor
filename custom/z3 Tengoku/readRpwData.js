'use strict';
/**
 * 第3次超级机器人大战Z：天狱篇 —— RPW_DATA.CPK 读取脚本
 *
 * 由主进程 file:read 调用（config.json -> loadFiles.RPW_DATA.readScript）。
 *
 * 执行流程：
 *   1. 拿到 ctx.filePath（用户在加载页输入 / 选择的游戏目录）
 *   2. 在该目录里查找 RPW_DATA.CPK
 *   3. 恰好找到唯一一个 → 把它的绝对路径赋值给 ctx.fileSrc
 *   4. 执行加载方法 loadFile(ctx)，用 ctx.fileSrc 读取该文件
 * 没找到或找到多个都抛错，提示重新选择游戏目录。
 *
 * 注意：ctx.filePath 可能来自界面手动输入，斜杠方向不确定，统一用 path.normalize 归一。
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
 * 在游戏目录里定位唯一的 RPW_DATA.CPK。
 * @param {string} dir 已规范化的游戏目录
 * @returns {string} RPW_DATA.CPK 的绝对路径
 */
function locateTarget(dir) {
	const found = [];
	findTargets(dir, found);
	// 0 个（没找到）或多个（目录不对 / 含多份）都视为目录选择有误
	if (found.length !== 1) throw new Error(ERROR_MESSAGE);
	return found[0];
}

/**
 * 加载方法：用 ctx.fileSrc 读取文件内容。
 * 解析动作待补充，目前先读入文件并返回路径与大小，证明读取成功。
 * @param {{ fileSrc: string }} ctx
 */
function loadFile(ctx) {
	const buffer = fs.readFileSync(ctx.fileSrc);
	return { fileSrc: ctx.fileSrc, size: buffer.length };
}

/**
 * @param {{ filePath?: string, fileSrc?: string }} ctx 主进程注入的上下文
 */
module.exports = function (ctx = {}) {
	const input = typeof ctx.filePath === 'string' ? ctx.filePath.trim().replace(/^"+|"+$/g, '') : '';
	if (!input) throw new Error(ERROR_MESSAGE);

	const dir = path.normalize(input);
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(ERROR_MESSAGE);

	// 1) 拿到 filePath 后在目录里找文件，确保只有唯一一个
	const target = locateTarget(dir);
	// 2) 把找到的文件地址赋值给 fileSrc
	ctx.fileSrc = target;
	// 3) 执行加载方法，传入 fileSrc 读取文件
	return loadFile(ctx);
};

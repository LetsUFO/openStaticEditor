// 使用 node 环境语法加载本系统下载目录下的 ufo.sav 文件
// 返回 { a: 1 } 作为加载成功的标记（后续会替换为真实的解析数据）
'use strict';

const { join } = require('node:path');
const { readFileSync } = require('node:fs');

/**
 * @param {object} ctx
 * @param {string} ctx.downloadsPath  —— Electron app.getPath('downloads') 给出的系统下载目录绝对路径
 * @param {string} ctx.customDir      —— custom 目录绝对路径
 * @param {string} ctx.fileSrc        —— config.json 中配置的文件名（如 "ufo.sav"），会拼到 downloadsPath 之后
 * @param {string} ctx.filePath       —— 解析后的绝对路径（本脚本未使用）
 * @returns {{ a: number }}
 */
module.exports = function (ctx) {
	const target = join(ctx.downloadsPath, ctx.fileSrc);
	// 仅验证文件可读，暂不解析内容；后续根据 ufo.sav 的实际格式再扩展
	readFileSync(target);
	return { level: 1 };
};

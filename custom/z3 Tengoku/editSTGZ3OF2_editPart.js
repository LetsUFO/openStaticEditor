/**
 * STGZ3OF2.SDAT —— 序章1 / 序章2「机体零件」功能（从 editSTGZ3OF2.js 剥离）
 *
 * 作用：给预设脚本里独角兽（机体 ID 264）的「所持」记录写入 4 个零件槽。
 *   - 序章1 → CPK 条目 ID 1（TOUROKU_000 / TOUROKU_001）
 *   - 序章2 → CPK 条目 ID 7（同一张 TOUROKU 表结构）
 * 只改 type 0 的「所持」记录；type 1 出击引用记录、HDR 队列表一律不碰。
 *
 * 两种用法（本文件须与 editSTGZ3OF2.js 放在同一目录）：
 *   1) 纯逻辑模块：被 editSTGZ3OF2.js require，在一次全量写回中附带改动零件
 *      const parts = require('./editSTGZ3OF2_unicornParts.js');
 *      parts.normalizeUnicornParts(value);
 *      parts.applyToEntries(entries, parts1, parts2);
 *   2) 单独作为 openStaticEditor 功能脚本：module.exports(ctx) 自己完成
 *      「解密 → 只改零件 → 重打包写回」，不触碰 GIFT 奖励表与所持机体注入。
 *      ctx.filePath / ctx.data.fileSrc —— SDAT 路径
 *      ctx.data.stage0_1.unicornParts / ctx.data.stage0_2.unicornParts —— 各 4 个零件 ID 数组
 *
 * 底层（EDAT 解密 / CRILAYLA / UTF 表 / CPK 重打包）复用 editSTGZ3OF2.js 导出的
 * loadPlainCpk / repackCpkWith，本文件只保留零件业务所需的 Lua 文本工具，便于单独维护。
 */
'use strict';

const fs = require('node:fs');

// 序章 UE 独角兽（机体 ID 264）的 4 个零件槽；空槽用 -1 表示
const UNICORN_UNIT_ID = 264;
const PART_SLOT_COUNT = 4;
const PART_ID_MAX = 78;

// ---------------- Lua 表文本工具（自包含副本，与主脚本实现一致） ----------------
function findLuaTable(presetText, tableName) {
	const assignment = new RegExp(`\\b${tableName}\\s*=\\s*\\{`).exec(presetText);
	if (!assignment) return null;
	const open = assignment.index + assignment[0].lastIndexOf('{');
	let depth = 0;
	let quote = '';
	let escaped = false;
	for (let i = open; i < presetText.length; i++) {
		const ch = presetText[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) {
			return { open, close: i, body: presetText.slice(open + 1, i) };
		}
	}
	throw new Error(`${tableName} 表缺少结束括号`);
}

function splitLuaValues(body) {
	const values = [];
	let start = 0;
	let depth = 0;
	let quote = '';
	let escaped = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '{' || ch === '[' || ch === '(') depth++;
		else if (ch === '}' || ch === ']' || ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			const value = body.slice(start, i).trim();
			if (value) values.push(value);
			start = i + 1;
		}
	}
	const tail = body.slice(start).trim();
	if (tail) values.push(tail);
	return values;
}

// ---------------- 参数规范化 ----------------
function normalizeUnicornParts(value) {
	if (!Array.isArray(value)) return [];
	const slots = value.slice(0, PART_SLOT_COUNT).map((id) => {
		if (id === undefined || id === null || id === '') return -1;
		const n = Number(id);
		if (!Number.isInteger(n) || n <= 0 || n > PART_ID_MAX) {
			throw new Error(`无效的机体零件 ID：${id}`);
		}
		return n;
	});
	while (slots.length < PART_SLOT_COUNT) slots.push(-1);
	return slots;
}

/** 从 ctx.data 读取序章1 / 序章2 的零件配置 */
function readUnicornParts(ctx) {
	const data = (ctx && ctx.data) || {};
	return {
		parts1: normalizeUnicornParts(data.stage0_1 && data.stage0_1.unicornParts),
		parts2: normalizeUnicornParts(data.stage0_2 && data.stage0_2.unicornParts)
	};
}

// ---------------- 零件槽写入 ----------------
/**
 * 给预设脚本里独角兽（机体 ID 264）的单位记录写入 4 个零件槽。
 * 必须同时改两条记录：
 *   - 「所持」type 0（TOUROKU_000）
 *   - 「出击」type 1（TOUROKU_001）
 * 只改所持、不改出击，会让出击记录与所持记录的零件不一致，进游戏后该机被视为「未参战」。
 * 记录格式为「类型,零件1..4,机体ID,机师ID,...」；HDR 队列表里 264 前面是队名字符串，不会被匹配。
 */
function updateUnicornParts(presetRaw, parts) {
	if (!parts.length) return presetRaw;
	let text = presetRaw.toString('latin1');
	for (const tableName of ['TOUROKU_000', 'TOUROKU_001']) {
		const table = findLuaTable(text, tableName);
		if (!table) continue;
		const m = new RegExp(
			`(-?\\d+),(-?\\d+),(-?\\d+),(-?\\d+),${UNICORN_UNIT_ID},(\\d+),`
		).exec(table.body);
		if (!m) continue;
		const pilotId = m[5];
		const replacement = `${parts.join(',')},${UNICORN_UNIT_ID},${pilotId},`;
		const at = table.open + 1 + m.index;
		text = text.slice(0, at) + replacement + text.slice(at + m[0].length);
	}
	return Buffer.from(text, 'latin1');
}

/**
 * 在已取出的 CPK 条目上应用序章1 / 序章2 的零件配置。
 * @param {{id: number, raw: Buffer}[]} entries repackCpkWith 解出的全部条目
 * @param {number[]} parts1 序章1 独角兽的 4 个零件槽（空数组 = 不改）
 * @param {number[]} parts2 序章2 独角兽的 4 个零件槽（空数组 = 不改）
 */
function applyToEntries(entries, parts1, parts2) {
	const preset1 = entries.find((e) => e.id === 1);
	if (!preset1) throw new Error('CPK 内找不到序章1预设脚本（ID 1）');
	if (parts1.length) preset1.raw = updateUnicornParts(preset1.raw, parts1);

	// 序章2（ID7）的预设脚本：写入序章2 自己的独角兽零件配置
	const preset2 = entries.find((e) => e.id === 7);
	if (preset2 && parts2.length) preset2.raw = updateUnicornParts(preset2.raw, parts2);
}

// ---------------- 独立入口（只改零件，不碰奖励） ----------------
/**
 * @param {{ filePath?: string, data?: any }} ctx 主进程注入的上下文
 */
function run(ctx = {}) {
	const filePath = ctx.filePath || (ctx.data && ctx.data.fileSrc) || '';
	if (!filePath)
		throw new Error('缺少关卡文件路径（ctx.filePath 为空），请重新加载 STGZ3OF2.SDAT');

	const { parts1, parts2 } = readUnicornParts(ctx);
	if (!parts1.length && !parts2.length) {
		console.log(`[unicornParts] 未配置序章机体零件，跳过写回：${filePath}`);
		return { fileSrc: filePath, size: fs.statSync(filePath).size, skipped: true };
	}

	// 延迟 require：主脚本顶层会 require 本模块，这样不会形成顶层循环依赖。
	const core = require('./editSTGZ3OF2.js');
	const plain = core.loadPlainCpk(filePath);
	const packed = core.repackCpkWith(plain, (entries) =>
		applyToEntries(entries, parts1, parts2)
	);
	fs.writeFileSync(filePath, packed);

	console.log(
		`[unicornParts] ${filePath} 已写回：${plain.length} → ${packed.length} 字节（仅序章机体零件，明文 CPK）`
	);
	return { fileSrc: filePath, size: packed.length };
}

module.exports = run;
module.exports.normalizeUnicornParts = normalizeUnicornParts;
module.exports.updateUnicornParts = updateUnicornParts;
module.exports.applyToEntries = applyToEntries;
module.exports.readUnicornParts = readUnicornParts;

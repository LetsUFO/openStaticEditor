/**
 * STGZ3OF2.SDAT 保存脚本（第一阶段：结构级重打包，不做压缩）
 *
 * 执行流程：
 *   1. 读取 ctx.filePath（关卡文件绝对路径）
 *   2. NPD/EDAT v4 → 解密出明文 CPK（若已经是明文 CPK 则直接使用）
 *   3. 按 ItocL / ItocH 的 ID 顺序依次取出每个文件
 *      - 以 CRILAYLA 开头的走解压，其余视为原始数据
 *   4. 检查序章 ID1 / ID2 的奖励表与 StageClear 调用，不存在则创建
 *      - 将 stage0.giftPart 中的零件按数量 99 写入，保留其他类型奖励
 *   5. 按原文件的排版规则（ContentOffset 起、每条按 16 字节对齐）重新拼装内容区
 *   6. 回填 CpkHeader（ContentSize / EnabledPackedSize / EnabledDataSize）
 *      与 ItocL / ItocH 每条记录的 FileSize / ExtractSize（改为未压缩长度）
 *   7. 以明文 CPK 覆盖写回原路径
 *
 * 注意：本阶段不重新进行 CRILAYLA 压缩或 EDAT 加密，按已验证可读取的明文 CPK 写回。
 */
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

// ---- RPCS3 key_vault.h 常量 ----
const SDAT_KEY = Buffer.from('0d655ef8e674a98ab8505cfa7d012933', 'hex');
const EDAT_KEY_1 = Buffer.from('4ca9c14b01c95309969bec68aa0bc081', 'hex');

const align16 = (n) => (n + 0x0f) & ~0x0f;
const be16 = (b, o) => b.readUInt16BE(o);
const be32 = (b, o) => b.readUInt32BE(o);
const be64 = (b, o) => Number(b.readBigUInt64BE(o));

// ---------------- AES ----------------
function aesEcbEnc(key, data) {
	const c = crypto.createCipheriv('aes-128-ecb', key, null);
	c.setAutoPadding(false);
	return Buffer.concat([c.update(data), c.final()]);
}
function aesEcbDec(key, data) {
	const c = crypto.createDecipheriv('aes-128-ecb', key, null);
	c.setAutoPadding(false);
	return Buffer.concat([c.update(data), c.final()]);
}
function aesCbcDec(key, iv, data) {
	const c = crypto.createDecipheriv('aes-128-cbc', key, iv);
	c.setAutoPadding(false);
	return Buffer.concat([c.update(data), c.final()]);
}

// ---------------- EDAT / NPD ----------------
function parseNpdHeader(d) {
	const h = {
		version: d.readInt32BE(0x04),
		digest: d.subarray(0x40, 0x50),
		devHash: d.subarray(0x60, 0x70)
	};
	h.flags = d.readInt32BE(0x80);
	h.blockSize = d.readUInt32BE(0x84);
	h.fileSize = be64(d, 0x88);
	return h;
}

/** 解密出明文 CPK；已经是明文 CPK 时原样返回 */
function loadPlainCpk(filePath) {
	const raw = fs.readFileSync(filePath);
	const magic = raw.toString('latin1', 0, 4);
	if (magic === 'CPK ') return raw;
	if (magic !== 'NPD\0') {
		throw new Error(`文件格式不符：既不是 NPD/EDAT 也不是 CPK（${filePath}）`);
	}

	const npd = parseNpdHeader(raw);
	const totalBlocks = Math.ceil(npd.fileSize / npd.blockSize);
	const metaSecSize = npd.flags & 1 || npd.flags & 0x20 ? 0x20 : 0x10;
	const cryptKey = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) cryptKey[i] = SDAT_KEY[i] ^ npd.devHash[i];

	const out = Buffer.alloc(npd.fileSize);
	let written = 0;
	for (let b = 0; b < totalBlocks; b++) {
		const metaOff = 0x100 + b * (metaSecSize + npd.blockSize);
		const plainLen = Math.min(npd.blockSize, npd.fileSize - b * npd.blockSize);
		const encLen = align16(plainLen);
		const dataOff = metaOff + 0x20;
		const enc = raw.subarray(dataOff, dataOff + encLen);

		const bKey = Buffer.alloc(16);
		npd.devHash.copy(bKey, 0, 0, 12);
		bKey.writeInt32BE(b, 12);
		const keyFinal = aesEcbDec(EDAT_KEY_1, aesEcbEnc(cryptKey, bKey));
		const dec = aesCbcDec(keyFinal, npd.digest, enc);

		dec.copy(out, written, 0, plainLen);
		written += plainLen;
	}
	return out;
}

// ---------------- CRILAYLA ----------------
/**
 * CRILAYLA 解压（与 readRpwData.js 中实现一致）
 * @param {Buffer} file 已定位到 'CRILAYLA' 魔数的整个文件
 * @returns {Buffer} 解压后的数据（长度 = usize + 0x100）
 */
function decompressCrilayla(file) {
	const magic = file.indexOf('CRILAYLA');
	if (magic < 0) throw new Error('文件格式不符：找不到 CRILAYLA 压缩块');

	const block = file.subarray(magic);
	const usize = block.readUInt32LE(8);
	const hoff = block.readUInt32LE(12);
	if (!usize || usize > file.length * 64) throw new Error('文件格式不符：解压长度异常');

	const out = Buffer.alloc(usize + 0x100);
	block.copy(out, 0, hoff + 0x10, hoff + 0x10 + 0x100);

	let pos = block.length - 0x100 - 1;
	let pool = 0;
	let left = 0;
	const bits = (k) => {
		let v = 0;
		let got = 0;
		while (got < k) {
			if (left === 0) {
				pool = pos >= 0 ? block[pos] : 0;
				left = 8;
				pos--;
			}
			const take = Math.min(left, k - got);
			v = (v << take) | ((pool >>> (left - take)) & ((1 << take) - 1));
			left -= take;
			got += take;
		}
		return v;
	};

	const end = 0x100 + usize - 1;
	let done = 0;
	while (done < usize) {
		if (bits(1)) {
			let ref = end - done + bits(13) + 3;
			let len = 3;
			let full = true;
			for (const w of [2, 3, 5, 8]) {
				const t = bits(w);
				len += t;
				if (t !== (1 << w) - 1) {
					full = false;
					break;
				}
			}
			if (full) {
				for (;;) {
					const t = bits(8);
					len += t;
					if (t !== 255) break;
				}
			}
			for (let i = 0; i < len && done < usize; i++) {
				out[end - done] = out[ref];
				ref--;
				done++;
			}
		} else {
			out[end - done] = bits(8);
			done++;
		}
	}
	return out;
}

// ---------------- CPK / UTF 表 ----------------
const TSZ = [1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 4, 8];
const TFM = [
	'readUInt8', 'readInt8', 'readUInt16BE', 'readInt16BE',
	'readUInt32BE', 'readInt32BE', 'readBigUInt64BE', 'readBigInt64BE',
	'readFloatBE', 'readDoubleBE'
];

class UTFTable {
	/** @param {Buffer} buf 整个明文 CPK @param {number} off 表在 buf 中的绝对偏移 */
	constructor(buf, off) {
		this.buf = buf;
		this.off = off;
		this.tableSize = be32(buf, off + 4);
		this.rowsOff = be32(buf, off + 8);
		this.strOff = be32(buf, off + 12);
		this.nameOff = be32(buf, off + 20);
		this.ncols = be16(buf, off + 24);
		this.stride = be16(buf, off + 26);
		this.nrows = be32(buf, off + 28);
		this.strBase = off + 8 + this.strOff;
		this.rowsBase = off + 8 + this.rowsOff;
		this.name = this.cstr(this.strBase + this.nameOff);
		this.cols = [];
		let p = off + 32;
		for (let i = 0; i < this.ncols; i++) {
			const flag = buf[p];
			const nameOff = be32(buf, p + 1);
			p += 5;
			this.cols.push([flag, this.cstr(this.strBase + nameOff)]);
		}
		// 行内列（flag & 0x40）在行中的偏移
		this.layout = [];
		let at = 0;
		for (const [flag, name] of this.cols) {
			if (!(flag & 0x40)) continue;
			const t = flag & 0x0f;
			let sz = t === 10 ? 4 : t === 11 ? 8 : TSZ[t];
			if (!sz) continue;
			this.layout.push({ name, t, sz, at });
			at += sz;
		}
	}
	cstr(o) {
		if (o >= this.buf.length) return '<oob>';
		let e = this.buf.indexOf(0, o);
		if (e < 0) e = this.buf.length;
		return this.buf.toString('utf8', o, e);
	}
	rows() {
		const out = [];
		for (let r = 0; r < this.nrows; r++) {
			const base = this.rowsBase + r * this.stride;
			const row = {};
			for (const c of this.layout) {
				const p = base + c.at;
				if (c.t === 10) {
					const so = be32(this.buf, p);
					row[c.name] = so ? this.cstr(this.strBase + so) : '';
				} else if (c.t === 11) {
					row[c.name] = [be32(this.buf, p), be32(this.buf, p + 4)];
				} else {
					const fn = TFM[c.t];
					if (!fn) continue;
					let v = this.buf[fn](p);
					if (typeof v === 'bigint') v = Number(v);
					row[c.name] = v;
				}
			}
			out.push(row);
		}
		return out;
	}
	/** 行内列的绝对写入位置 */
	fieldPos(rowIndex, name) {
		const c = this.layout.find((it) => it.name === name);
		if (!c) return -1;
		return this.rowsBase + rowIndex * this.stride + c.at;
	}
	setField(rowIndex, name, value) {
		const c = this.layout.find((it) => it.name === name);
		if (!c) throw new Error(`表 ${this.name} 缺少字段 ${name}`);
		const p = this.rowsBase + rowIndex * this.stride + c.at;
		if (c.sz === 8) { this.buf.writeBigUInt64BE(BigInt(value), p); return; }
		if (c.sz === 4) { this.buf.writeUInt32BE(value, p); return; }
		if (c.sz === 2) {
			if (value > 0xffff) throw new Error(`${this.name}.${name} 超出 u16 范围：${value}`);
			this.buf.writeUInt16BE(value, p);
			return;
		}
		this.buf.writeUInt8(value, p);
	}
}

function findAllUtfs(buf, limit) {
	const res = [];
	let i = 0;
	for (;;) {
		i = buf.indexOf('@UTF', i, 'latin1');
		if (i < 0) break;
		if (i + 32 <= buf.length) {
			const ts = be32(buf, i + 4);
			if (ts >= 32 && i + ts <= buf.length) res.push([i, ts]);
		}
		i += 4;
		if (limit && res.length >= limit) break;
	}
	return res;
}

function normalizeGiftPart(value) {
	if (!Array.isArray(value)) throw new Error('缺少 stage0.giftPart，数据格式应为零件 ID 数组');
	return value.filter((id) => id !== undefined && id !== null && id !== '').map((id) => {
		const n = Number(id);
		if (!Number.isInteger(n) || n <= 0) throw new Error(`无效的机体零件 ID：${id}`);
		return n;
	});
}

function normalizeGiftUnit(value) {
	// giftUnit 允许为空数组（用户可以一个机体都不选），不存在时返回 []
	if (!Array.isArray(value)) return [];
	// 过滤掉表单中未选择的（null/undefined/''），得到紧凑的有效 ID 数组
	return value.filter((id) => id !== undefined && id !== null && id !== '').map((id) => {
		const n = Number(id);
		if (!Number.isInteger(n) || n <= 0) throw new Error(`无效的机体 ID：${id}`);
		return n;
	});
}

// 序章 UE 独角兽（机体 ID 264）的 4 个零件槽；空槽用 -1 表示
const UNICORN_UNIT_ID = 264;
const PART_SLOT_COUNT = 4;
const PART_ID_MAX = 78;

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

/**
 * 给预设脚本里独角兽（机体 ID 264）的「所持」记录写入 4 个零件槽。
 * 只改 type 0 记录（0,零件1..4,机体ID,机师ID,...）；出击引用记录（type 1）的对应字段
 * 并非零件槽，写进去会破坏出击编成、导致出击的独角兽消失，故绝不触碰。
 * HDR 队列表里的 264 前面是队名字符串，也不会被匹配。
 */
function updateUnicornParts(presetRaw, parts) {
	if (!parts.length) return presetRaw;
	let text = presetRaw.toString('latin1');
	for (const tableName of ['TOUROKU_000', 'TOUROKU_001']) {
		const table = findLuaTable(text, tableName);
		if (!table) continue;
		const values = splitLuaValues(table.body);
		if (values.length < 3) continue;
		let changed = false;
		// 自第 4 个值起是记录区；寻找 type 0 且机体 ID 为 264 的记录
		for (let i = 3; i + 7 <= values.length; i++) {
			if (values[i] !== '0' || values[i + 5] !== String(UNICORN_UNIT_ID)) continue;
			// 记录形如 0,p1,p2,p3,p4,264,pilot,...，各字段均应为整数
			if (![1, 2, 3, 4, 6].every((k) => /^-?\d+$/.test(values[i + k]))) continue;
			values[i + 1] = String(parts[0]);
			values[i + 2] = String(parts[1]);
			values[i + 3] = String(parts[2]);
			values[i + 4] = String(parts[3]);
			changed = true;
			break;
		}
		if (!changed) continue;
		text = text.slice(0, table.open + 1) + values.join(',') + ',' + text.slice(table.close);
	}
	return Buffer.from(text, 'latin1');
}

function findStageClearGiftName(stageText) {
	const decl = /\bfunction\s+EventFunc_StageClear\s*\(\s*\)/.exec(stageText);
	if (!decl) throw new Error('序章关卡脚本缺少 EventFunc_StageClear');
	const bodyStart = decl.index + decl[0].length;
	const rest = stageText.slice(bodyStart);
	const next = /\bfunction\s+/.exec(rest);
	const body = next ? rest.slice(0, next.index) : rest;
	const call = /\bSC_GIFT_EXEC_B\s*\(\s*(GIFT_[A-Za-z0-9_]+)\s*\)/.exec(body);
	return call ? call[1] : '';
}

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

function updateStageGift(presetRaw, stageRaw, giftPart, giftUnit) {
	let presetText = presetRaw.toString('latin1');
	let stageText = stageRaw.toString('latin1');
	let giftName = findStageClearGiftName(stageText);
	const hasGiftCall = Boolean(giftName);
	if (!giftName) giftName = 'GIFT_500';

	const table = findLuaTable(presetText, giftName);
	// 文件里本来没有奖励表、本次也没有配置奖励时不做任何改动，
	// 避免只改独角兽零件时给关卡脚本插入空的 GIFT 调用。
	if (!hasGiftCall && !table && !giftPart.length && !giftUnit.length) {
		return { preset: presetRaw, stage: stageRaw };
	}
	const values = table ? splitLuaValues(table.body) : ['0'];
	const oldCount = Number(values[0]);
	if (!values.length || !Number.isInteger(oldCount) || oldCount < 0 || values.length !== 1 + oldCount * 8) {
		throw new Error(`${giftName} 奖励表结构异常`);
	}

	// 删除旧零件/旧机体记录，保留资金、消息等其他奖励，再按表单顺序写入数量 99 的零件和数量 0 的机体。
	const records = [];
	for (let i = 0; i < oldCount; i++) {
		const at = 1 + i * 8;
		const kind = Number(values[at + 3]);
		if (kind !== 1 && kind !== 2) records.push(values.slice(at, at + 8));
	}
	for (const id of giftPart) records.push(['-1', '-1', '0', '1', String(id), '""', '99', '0']);
	for (const id of giftUnit) records.push(['-1', '-1', '0', '2', String(id), '""', '0', '0']);
	const body = [String(records.length), ...records.flat()].join(',');
	const literal = `${giftName}={${body},}`;
	if (table) {
		presetText = presetText.slice(0, table.open) + literal.slice(literal.indexOf('{')) + presetText.slice(table.close + 1);
	} else {
		presetText = `${literal}\r\n${presetText}`;
	}

	if (!hasGiftCall) {
		const decl = /\bfunction\s+EventFunc_StageClear\s*\(\s*\)/.exec(stageText);
		const insertAt = decl.index + decl[0].length;
		const newline = /^(?:\r\n|\r|\n)/.exec(stageText.slice(insertAt))?.[0] || '\r\n';
		stageText = stageText.slice(0, insertAt) + `${newline}SC_GIFT_EXEC_B(${giftName});` + stageText.slice(insertAt);
	}

	return { preset: Buffer.from(presetText, 'latin1'), stage: Buffer.from(stageText, 'latin1') };
}

/* ------------------------------------------------------------------ */
/* TOUROKU 所持机体注入                                                */
/* ------------------------------------------------------------------ */

// 本编辑器注入的「所持机体」记录 = type 0，共 20 字段
const INJECTED_UNIT_FIELDS = 20;

/** 生成一条 type 0 所持记录（机师 -1，由玩家在换乘里指定） */
function buildInjectedUnitRecord(id) {
	return [
		'0', '-1', '-1', '-1', '-1', String(id), '-1',
		'0', '0', '0', '0', '0', '0', '0', '0', '0',
		'true', 'true', 'false', 'false'
	];
}

/**
 * 判断扁平值数组自 index 起 20 个值，是否为「机体 id」的注入记录。
 * 记录格式：0, 零件1..4(-1), 机体ID, 机师ID(-1), 0×9, true,true,false,false
 * 兼容两种历史 bool 尾：新 true,true,false,false / 旧 false,true,false,false。
 */
function isInjectedUnitAt(values, index, id) {
	if (values[index] !== '0') return false;
	for (const k of [1, 2, 3, 4, 6]) if (values[index + k] !== '-1') return false;
	if (values[index + 5] !== String(id)) return false;
	for (let k = 7; k <= 15; k++) if (values[index + k] !== '0') return false;
	const tail = `${values[index + 16]},${values[index + 17]},${values[index + 18]},${values[index + 19]}`;
	return tail === 'true,true,false,false' || tail === 'false,true,false,false';
}

/**
 * 从扁平值数组里剔除属于 giftUnit 的注入记录。
 * 只按「机体 ID + 固定签名」精确匹配，绝不触碰其它原生记录（例如原生就存在的无机师机体 298）。
 */
function stripInjectedUnits(values, giftUnit) {
	const ids = new Set(giftUnit.map((id) => String(id)));
	const starts = [];
	for (let i = 0; i + INJECTED_UNIT_FIELDS <= values.length; i++) {
		if (values[i] === '0' && ids.has(values[i + 5]) && isInjectedUnitAt(values, i, values[i + 5])) {
			starts.push(i);
		}
	}
	for (let k = starts.length - 1; k >= 0; k--) values.splice(starts[k], INJECTED_UNIT_FIELDS);
	return starts.length;
}

/**
 * 把奖励机体以 type 0 记录写入指定预设的 TOUROKU 表（所持机体表）。
 * 该关卡 EventFunc_StageClear 会调用 SC_PLAYER_ENTRY(tableName)，机体因此登记为「所持」，
 * 出现在改造 / 零件 / 换乘；只写所持表不会把机体塞进出击编成。
 *
 * 不同章节的 TOUROKU 表里可能含未知记录类型（如 type 2/10/5），因此不按类型长度整表解析：
 * 仅按机体 ID 精确剔除/追加本编辑器注入的 type 0 记录，其余原生记录（含未知类型）原样保留。
 * @param {string} presetText 预设脚本文本
 * @param {number[]} giftUnit 奖励机体 ID
 * @param {string} tableName 目标 TOUROKU 表名
 * @param {boolean} add 剔除后是否追加本次记录（清理旧表时传 false）
 */
function updateGiftUnits(presetText, giftUnit, tableName, add = true) {
	const table = findLuaTable(presetText, tableName);
	if (!table) {
		if (!add || !giftUnit.length) return presetText;
		throw new Error(`预设脚本缺少 ${tableName}，无法写入奖励机体`);
	}
	const values = splitLuaValues(table.body);
	if (values.length < 3) throw new Error(`${tableName} 表结构异常`);
	const oldCount = Number(values[1]);
	if (!Number.isInteger(oldCount) || oldCount < 0) throw new Error(`${tableName} 记录数异常`);

	const records = values.slice(3);
	const removed = stripInjectedUnits(records, giftUnit);
	const added = add ? [...new Set(giftUnit)].map((id) => buildInjectedUnitRecord(id)) : [];
	if (removed === 0 && added.length === 0) return presetText;

	const newCount = oldCount - removed + added.length;
	const body = [values[0], String(newCount), values[2], ...records, ...added.flat()].join(',') + ',';
	return presetText.slice(0, table.open + 1) + body + presetText.slice(table.close);
}

// 序章（entry 2）StageClear 调 SC_PLAYER_ENTRY(TOUROKU_000)：写进所持表（entry 1 预设的 TOUROKU_000）
function updatePrologueGiftUnits(presetText, giftUnit) {
	// 清掉旧版本误写进出击表 TOUROKU_001 的注入记录（仅按 ID 精确剔除）
	const cleaned = updateGiftUnits(presetText, giftUnit, 'TOUROKU_001', false);
	return updateGiftUnits(cleaned, giftUnit, 'TOUROKU_000', true);
}

// 第一话（entry 20）StageClear 会调 SC_PLAYER_ENTRY(TOUROKU_000/001/002)。
// entry 19 预设里 type 0 单机所持记录位于 TOUROKU_001（TOUROKU_000 只有 7 条多座机 731/732），故写 TOUROKU_001。
function updateStage1GiftUnits(presetText, giftUnit) {
	// 清掉旧版本误写进部队表 TOUROKU_002 / TOUROKU_000 的注入记录（仅按 ID 精确剔除）
	let out = updateGiftUnits(presetText, giftUnit, 'TOUROKU_002', false);
	out = updateGiftUnits(out, giftUnit, 'TOUROKU_000', false);
	return updateGiftUnits(out, giftUnit, 'TOUROKU_001', true);
}

/**
 * 重新打包明文 CPK（不压缩），返回新的 Buffer
 * @param {Buffer} plain 明文 CPK
 * @param {number[]} giftPart 序章奖励零件 ID
 * @param {number[]} giftUnit 序章奖励机体 ID
 * @param {number[]} unicornParts1 序章1 独角兽的 4 个零件槽
 * @param {number[]} unicornParts2 序章2 独角兽的 4 个零件槽
 * @param {number[]} stage1GiftPart 第一话奖励零件 ID
 * @param {number[]} stage1GiftUnit 第一话奖励机体 ID
 */
function repackCpk(plain, giftPart, giftUnit, unicornParts1, unicornParts2, stage1GiftPart, stage1GiftUnit) {
	const tables = findAllUtfs(plain).map(([off]) => new UTFTable(plain, off));
	if (!tables.length) throw new Error('CPK 内没有找到 @UTF 表');

	const header = tables.find((t) => t.name === 'CpkHeader') || tables[0];
	if (!header.nrows) throw new Error('CpkHeader 为空');
	const hdr = header.rows()[0];
	const contentOffset = hdr.ContentOffset;
	const align = hdr.Align || 16;
	if (!contentOffset) throw new Error('CpkHeader 缺少 ContentOffset');

	// 收集 ItocL / ItocH 的文件条目（按 ID 升序，内容区按此顺序排列）
	const idTables = tables.filter((t) => t.cols.length && t.cols[0][1] === 'ID');
	const entries = [];
	for (const t of idTables) {
		t.rows().forEach((row, idx) => {
			const extractKey = ['ExtractSi', 'ExtractSize'].find((key) => row[key] !== undefined);
			if (!extractKey) throw new Error(`文件 ${row.ID} 缺少 ExtractSize 字段`);
			entries.push({ table: t, idx, id: row.ID, fileSize: row.FileSize, extractKey, extractSize: row[extractKey] });
		});
	}
	entries.sort((a, b) => a.id - b.id);
	if (entries.length !== hdr.Files) {
		throw new Error(`条目数量异常：表内 ${entries.length}，头部 ${hdr.Files}`);
	}

	// 先按原偏移完整取出所有条目，再修改序章脚本，避免变长数据影响后续读取。
	let srcCursor = contentOffset;
	for (const e of entries) {
		srcCursor = Math.ceil(srcCursor / align) * align;
		const comp = plain.subarray(srcCursor, srcCursor + e.fileSize);
		const raw = comp.toString('latin1', 0, 8) === 'CRILAYLA' ? decompressCrilayla(comp) : comp;
		if (raw.length !== e.extractSize) {
			throw new Error(`文件 ${e.id} 长度不符：解出 ${raw.length}，表内 ${e.extractSize}`);
		}
		e.raw = raw;
		srcCursor += e.fileSize;
	}

	const preset = entries.find((e) => e.id === 1);
	const stage = entries.find((e) => e.id === 2);
	if (!preset || !stage) throw new Error('CPK 内找不到序章脚本（ID 1 / ID 2）');
	const updated = updateStageGift(preset.raw, stage.raw, giftPart, giftUnit);
	const presetWithUnits = Buffer.from(
		updatePrologueGiftUnits(updated.preset.toString('latin1'), giftUnit),
		'latin1'
	);
	preset.raw = updateUnicornParts(presetWithUnits, unicornParts1);
	stage.raw = updated.stage;

	// 序章2（ID7）的预设脚本：写入序章2 自己的独角兽零件配置
	const preset2 = entries.find((e) => e.id === 7);
	if (preset2) preset2.raw = updateUnicornParts(preset2.raw, unicornParts2);

	// 第一话（ID19 预设 / ID20 关卡）：重写 GIFT_501 奖励表 + 把奖励机体注入所持表 TOUROKU_001
	const stage1Preset = entries.find((e) => e.id === 19);
	const stage1Stage = entries.find((e) => e.id === 20);
	if (stage1Preset && stage1Stage) {
		const stage1Updated = updateStageGift(
			stage1Preset.raw,
			stage1Stage.raw,
			stage1GiftPart,
			stage1GiftUnit
		);
		const stage1PresetWithUnits = Buffer.from(
			updateStage1GiftUnits(stage1Updated.preset.toString('latin1'), stage1GiftUnit),
			'latin1'
		);
		stage1Preset.raw = stage1PresetWithUnits;
		stage1Stage.raw = stage1Updated.stage;
	}

	// 所有修改完成后再计算新内容区布局。
	let pos = 0;
	let rawTotal = 0;
	for (const e of entries) {
		e.at = Math.ceil(pos / align) * align;
		pos = e.at + e.raw.length;
		rawTotal += e.raw.length;
	}

	// 拼内容区：每条按 align 对齐，末尾补零到 align
	const contentSize = Math.ceil(pos / align) * align;
	const content = Buffer.alloc(contentSize);
	for (const e of entries) e.raw.copy(content, e.at);

	// 回填头部字段
	header.setField(0, 'ContentSize', contentSize);
	header.setField(0, 'EnabledPackedSize', rawTotal);
	header.setField(0, 'EnabledDataSize', rawTotal);

	// 明文不重压缩，FileSize 与 ExtractSize 都必须改为未压缩长度。
	for (const e of entries) {
		e.table.setField(e.idx, 'FileSize', e.raw.length);
		e.table.setField(e.idx, e.extractKey, e.raw.length);
	}

	return Buffer.concat([plain.subarray(0, contentOffset), content]);
}

/**
 * @param {{ filePath?: string, dataKey?: string, data?: any }} ctx 主进程注入的上下文
 */
module.exports = function (ctx = {}) {
	const filePath = ctx.filePath || (ctx.data && ctx.data.fileSrc) || '';
	if (!filePath) throw new Error('缺少关卡文件路径（ctx.filePath 为空），请重新加载 STGZ3OF2.SDAT');

	const giftPart = normalizeGiftPart(ctx.data && ctx.data.stage0_1 && ctx.data.stage0_1.giftPart);
	const giftUnit = normalizeGiftUnit(ctx.data && ctx.data.stage0_1 && ctx.data.stage0_1.giftUnit);
	const unicornParts1 = normalizeUnicornParts(
		ctx.data && ctx.data.stage0_1 && ctx.data.stage0_1.unicornParts
	);
	const unicornParts2 = normalizeUnicornParts(
		ctx.data && ctx.data.stage0_2 && ctx.data.stage0_2.unicornParts
	);
	const stage1GiftPart = normalizeGiftPart(ctx.data && ctx.data.stage1 && ctx.data.stage1.giftPart);
	const stage1GiftUnit = normalizeGiftUnit(ctx.data && ctx.data.stage1 && ctx.data.stage1.giftUnit);
	const plain = loadPlainCpk(filePath);
	const packed = repackCpk(
		plain,
		giftPart,
		giftUnit,
		unicornParts1,
		unicornParts2,
		stage1GiftPart,
		stage1GiftUnit
	);
	fs.writeFileSync(filePath, packed);

	console.log(`[editSTGZ3OF2] ${filePath} 已写回：${plain.length} → ${packed.length} 字节（明文 CPK）`);
	return { fileSrc: filePath, size: packed.length };
};

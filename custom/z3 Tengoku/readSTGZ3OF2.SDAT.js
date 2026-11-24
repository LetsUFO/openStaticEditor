#!/usr/bin/env node
/**
 * readSTGZ3OF2.SDAT.js — 只读解析 STGZ3OF2.SDAT（NPDRM/EDAT v4 或明文 CPK）
 *
 * 由主进程 file:read 调用（config.json -> loadFiles.stage.readScript）。
 *
 * 执行流程：
 *   1. 拿到 ctx.filePath（用户在加载页输入 / 选择的游戏目录）
 *   2. 在该目录里查找 ctx.fileName（config.json -> loadFiles[key].fileName，默认 STGZ3OF2.SDAT）
 *   3. 把它的绝对路径赋值给 ctx.fileSrc
 *   4. 识别明文 CPK，或解析 NPD/EDAT v4 头并逐块解密，再解析 CPK 的 UTF 表
 *
 * 解密算法移植自 RPCS3 rpcs3/Crypto/unedat.cpp：
 *   - flags=0x0100003C（SDAT + 0x20 元数据前置 + 0x10 双重加密密钥 + 0x08 加密 ERK）
 *   - 文件密钥 crypt_key = SDAT_KEY XOR dev_hash
 *   - 每块：b_key = dev_hash[0..0xC] + block(BE s32)
 *           key_result = AES-128-ECB-Enc(crypt_key, b_key)
 *           key_final  = AES-128-ECB-Dec(EDAT_KEY_1, key_result)
 *           明文块     = AES-128-CBC-Dec(key_final, IV=npd.digest, 密文块)
 *
 * 只读：不写回任何原文件。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const findFile = require('./lib');

const DEFAULT_TARGET_NAME = 'STGZ3OF2.SDAT';
// 零件下拉选项表，与本脚本同目录（关卡奖励 select 的 optionUse=partList）
const PART_LIST_FILE = path.join(__dirname, 'partList.json');
const UNIT_LIST_FILE = path.join(__dirname, 'unitList.json');

// ---- RPCS3 key_vault.h 常量 ----
const SDAT_KEY = Buffer.from('0d655ef8e674a98ab8505cfa7d012933', 'hex');
const EDAT_KEY_1 = Buffer.from('4ca9c14b01c95309969bec68aa0bc081', 'hex');

// ---------------- 小工具 ----------------
const align16 = (n) => (n + 0x0f) & ~0x0f;
const be16 = (b, o) => b.readUInt16BE(o);
const be32 = (b, o) => b.readUInt32BE(o);
const be64 = (b, o) => Number(b.readBigUInt64BE(o));

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

// ---------------- EDAT/NPD 头 ----------------
function parseNpdHeader(d) {
	const magic = d.toString('latin1', 0, 4);
	if (magic !== 'NPD\0') {
		throw new Error('文件格式不符：不是 NPD/EDAT 文件');
	}
	const h = {
		magic: 'NPD\\0',
		version: d.readInt32BE(0x04),
		license: d.readInt32BE(0x08),
		type: d.readInt32BE(0x0c),
		contentId: d.toString('latin1', 0x10, 0x40).replace(/\0.*$/, ''),
		digest: d.subarray(0x40, 0x50),
		titleHash: d.subarray(0x50, 0x60),
		devHash: d.subarray(0x60, 0x70),
		activateTime: Number(d.readBigInt64BE(0x70)),
		expireTime: Number(d.readBigInt64BE(0x78))
	};
	h.flags = d.readInt32BE(0x80);
	h.blockSize = d.readUInt32BE(0x84);
	h.fileSize = be64(d, 0x88);
	return h;
}

// ---------------- 解密 ----------------
function decryptEdat(d, npd) {
	const totalBlocks = Math.ceil(npd.fileSize / npd.blockSize);
	const metadataOffset = 0x100;
	const metaSecSize = npd.flags & 1 || npd.flags & 0x20 ? 0x20 : 0x10;
	const cryptKey = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) cryptKey[i] = SDAT_KEY[i] ^ npd.devHash[i];

	const out = Buffer.alloc(npd.fileSize);
	let written = 0;
	for (let b = 0; b < totalBlocks; b++) {
		// 元数据在每块数据之前（flags & 0x20），本脚本只取数据区解密
		const metaOff = metadataOffset + b * (metaSecSize + npd.blockSize);

		// 明文长度 / 对齐后的密文长度
		const plainLen = Math.min(npd.blockSize, npd.fileSize - b * npd.blockSize);
		const encLen = align16(plainLen);
		const dataOff = metaOff + 0x20;
		const enc = d.subarray(dataOff, dataOff + encLen);

		// 块密钥
		const bKey = Buffer.alloc(16);
		npd.devHash.copy(bKey, 0, 0, 12);
		bKey.writeInt32BE(b, 12);
		const keyResult = aesEcbEnc(cryptKey, bKey);
		const keyFinal = aesEcbDec(EDAT_KEY_1, keyResult);
		const dec = aesCbcDec(keyFinal, npd.digest, enc);

		dec.copy(out, written, 0, plainLen);
		written += plainLen;
	}
	return out;
}

// ---------------- CRILAYLA ----------------
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

// ---------------- CPK / UTF 解析（大端，移植自 cpk3.py） ----------------
const TSZ = [1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 4, 8];
const TFM = [
	'readUInt8',
	'readInt8',
	'readUInt16BE',
	'readInt16BE',
	'readUInt32BE',
	'readInt32BE',
	'readBigUInt64BE',
	'readBigInt64BE',
	'readFloatBE',
	'readDoubleBE'
];

class UTFTable {
	constructor(d) {
		this.d = d;
		this.tableSize = be32(d, 4);
		this.rowsOff = be32(d, 8);
		this.strOff = be32(d, 12);
		this.dataOff = be32(d, 16);
		this.nameOff = be32(d, 20);
		this.ncols = be16(d, 24);
		this.stride = be16(d, 26);
		this.nrows = be32(d, 28);
		this.strBase = 8 + this.strOff;
		this.dataBase = 8 + this.dataOff;
		this.rowsBase = 8 + this.rowsOff;
		this.name = this.cstr(this.strBase + this.nameOff);
		this.cols = [];
		let p = 32;
		for (let i = 0; i < this.ncols; i++) {
			const flag = d[p];
			const nameOff = be32(d, p + 1);
			p += 5;
			this.cols.push([flag, this.cstr(this.strBase + nameOff)]);
		}
	}
	cstr(o) {
		if (o >= this.d.length) return '<oob>';
		let e = this.d.indexOf(0, o);
		if (e < 0) e = this.d.length;
		return this.d.toString('utf8', o, e);
	}
	rows() {
		const out = [];
		for (let r = 0; r < this.nrows; r++) {
			const base = this.rowsBase + r * this.stride;
			let p = base;
			const row = {};
			for (const [flag, name] of this.cols) {
				const t = flag & 0x0f;
				if (t === 10) {
					if (p + 4 > base + this.stride) continue;
					const so = be32(this.d, p);
					p += 4;
					row[name] = so ? this.cstr(this.strBase + so) : '';
				} else if (t === 11) {
					if (p + 8 > base + this.stride) continue;
					const do_ = be32(this.d, p);
					const dl = be32(this.d, p + 4);
					p += 8;
					row[name] = [this.dataBase + do_, dl];
				} else {
					const sz = TSZ[t] || 0;
					if (!sz || p + sz > base + this.stride) continue;
					const fn = TFM[t];
					let v = this.d[fn](p);
					if (typeof v === 'bigint') v = Number(v);
					row[name] = v;
					p += sz;
				}
			}
			out.push(row);
		}
		return out;
	}
}

function findAllUtfs(buf) {
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
	}
	return res;
}

function esizeOf(e) {
	for (const k of Object.keys(e)) {
		if (k.startsWith('Extract') || k === 'Extra') return e[k];
	}
	return 0;
}

function parseCpk(buf) {
	const head = buf.subarray(0, Math.min(buf.length, 4 << 20));
	const tables = [];
	for (const [off, ts] of findAllUtfs(head)) {
		try {
			const u = new UTFTable(head.subarray(off, off + ts));
			tables.push({ off, utf: u, tableSize: ts });
		} catch {
			/* 忽略坏表 */
		}
	}
	if (!tables.length) throw new Error('文件格式不符：CPK 内没有找到 @UTF 表');

	const headerRow = tables[0].utf.nrows ? tables[0].utf.rows()[0] : {};
	const lastTableEnd = Math.max(...tables.map((t) => t.off + t.tableSize));

	const L = [];
	const H = [];
	for (const { utf } of tables) {
		const names = utf.cols.map((c) => c[1]);
		if (names.length < 2 || names[0] !== 'ID' || !names[1].startsWith('FileSize')) continue;
		const rows = utf.rows();
		if (utf.stride === 6) L.push(...rows);
		else H.push(...rows);
	}
	const entries = L.concat(H).sort((a, b) => a.ID - b.ID);

	// content_start：头表里位于所有表之后、文件之内的最小整数偏移
	let contentStart = lastTableEnd;
	const cands = [];
	for (const v of Object.values(headerRow)) {
		if (typeof v === 'number' && v >= lastTableEnd && v < buf.length) cands.push(v);
	}
	if (cands.length) contentStart = Math.min(...cands);

	return { headerRow, lastTableEnd, entries, contentStart };
}

function readCpkEntry(plain, cpk, id) {
	const align = cpk.headerRow.Align || 16;
	let cursor = cpk.contentStart;
	for (const e of cpk.entries) {
		cursor = Math.ceil(cursor / align) * align;
		if (e.ID === id) {
			const comp = plain.subarray(cursor, cursor + e.FileSize);
			const raw =
				comp.toString('latin1', 0, 8) === 'CRILAYLA' ? decompressCrilayla(comp) : comp;
			const extractSize = esizeOf(e);
			if (raw.length !== extractSize) {
				throw new Error(`文件 ${id} 长度不符：解出 ${raw.length}，表内 ${extractSize}`);
			}
			return raw;
		}
		cursor += e.FileSize;
	}
	throw new Error(`CPK 内找不到序章脚本（ID ${id}）`);
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
	throw new Error(`${giftName} 奖励表缺少结束括号`);
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

function readGiftIds(presetText, giftName) {
	if (!giftName) return { giftPart: [], giftUnit: [] };
	const table = findLuaTable(presetText, giftName);
	if (!table) return { giftPart: [], giftUnit: [] };
	const values = splitLuaValues(table.body);
	const count = Number(values[0]);
	if (
		!values.length ||
		!Number.isInteger(count) ||
		count < 0 ||
		values.length !== 1 + count * 8
	) {
		throw new Error(`${giftName} 奖励表结构异常`);
	}
	const giftPart = [];
	const giftUnit = [];
	for (let i = 0; i < count; i++) {
		const at = 1 + i * 8;
		const kind = Number(values[at + 3]);
		const id = Number(values[at + 4]);
		if (kind === 1) {
			if (!Number.isInteger(id) || id <= 0) throw new Error(`${giftName} 包含无效零件 ID`);
			giftPart.push(id);
		} else if (kind === 2) {
			if (!Number.isInteger(id)) throw new Error(`${giftName} 包含无效机体 ID`);
			giftUnit.push(id);
		}
	}
	return { giftPart, giftUnit };
}

/**
 * 读取某个关卡的奖励：
 *   - stageId：关卡脚本 entry（其 EventFunc_StageClear 里调用 SC_GIFT_EXEC_B(GIFT_xxx)）
 *   - presetId：该关卡的预设脚本 entry（定义 GIFT_xxx 表）
 * 序章/第一话等都遵循「预设 N-1 定义表、关卡 N 调用」的配对规则。
 */
function readStageGift(plain, cpk, stageId, presetId) {
	const stageText = readCpkEntry(plain, cpk, stageId).toString('latin1');
	const giftName = findStageClearGiftName(stageText);
	if (!giftName) return { giftPart: [], giftUnit: [] };
	const presetText = readCpkEntry(plain, cpk, presetId).toString('latin1');
	return readGiftIds(presetText, giftName);
}

function readPrologueGift(plain, cpk) {
	return readStageGift(plain, cpk, 2, 1);
}

// 第一话（本編第一关）：关卡脚本 ID 20（StageClear 调 SC_GIFT_EXEC_B(GIFT_501)），
// 预设脚本 ID 19 定义 GIFT_501 表。
function readStage1Gift(plain, cpk) {
	return readStageGift(plain, cpk, 20, 19);
}

// 序章 1/2 里我方配置的独角兽（机体 ID 264）的 4 个零件槽。
// TOUROKU 表里单位记录格式为「类型,零件1..4,机体ID,机师ID,...」，
// 前面的 HDR 队列表（16,...,"队名",264,352）不会匹配，因为 264 前面是字符串。
const UNICORN_UNIT_ID = 264;

function readUnicornPartSlots(presetText) {
	const empty = [null, null, null, null];
	const table = findLuaTable(presetText, 'TOUROKU_000');
	if (!table) return empty;
	const m = new RegExp(
		`(-?\\d+),(-?\\d+),(-?\\d+),(-?\\d+),${UNICORN_UNIT_ID},\\d+,`
	).exec(table.body);
	if (!m) return empty;
	return [1, 2, 3, 4].map((i) => {
		const value = Number(m[i]);
		return Number.isInteger(value) && value > 0 ? value : null;
	});
}

/** 分别读取序章1（ID1）、序章2（ID7）的独角兽零件槽 */
function readPrologueUnicornParts(plain, cpk) {
	const prologue1 = readUnicornPartSlots(
		readCpkEntry(plain, cpk, 1).toString('latin1')
	);
	let prologue2 = [null, null, null, null];
	try {
		prologue2 = readUnicornPartSlots(
			readCpkEntry(plain, cpk, 7).toString('latin1')
		);
	} catch {
		// 没有序章2预设时保持空槽
	}
	return { prologue1, prologue2 };
}

/**
 * 加载方法：读取并解析 ctx.fileSrc 指向的 STGZ3OF2.SDAT。
 * @param {{ fileSrc: string }} ctx
 */
function loadFile(ctx) {
	const buffer = fs.readFileSync(ctx.fileSrc);
	const partList = JSON.parse(fs.readFileSync(PART_LIST_FILE, 'utf8'));
	const unitList = JSON.parse(fs.readFileSync(UNIT_LIST_FILE, 'utf8'));
	const magic = buffer.toString('latin1', 0, 4);
	// 保存脚本写回明文 CPK；原始文件仍需先解密 EDAT。
	const plain = magic === 'CPK ' ? buffer : decryptEdat(buffer, parseNpdHeader(buffer));
	const cpk = parseCpk(plain);
	const { giftPart, giftUnit } = readPrologueGift(plain, cpk);
	const stage1 = readStage1Gift(plain, cpk);
	const { prologue1, prologue2 } = readPrologueUnicornParts(plain, cpk);
	return {
		fileSrc: ctx.fileSrc,
		size: buffer.length,
		entries: cpk.entries.map((e) => ({
			id: e.ID,
			size: e.FileSize,
			extractSize: esizeOf(e)
		})),
		partList,
		unitList,
		// 关卡奖励（config.json -> menu「关卡奖励」的 dataKey=stage 读取的就是这块数据）
		// giftPart：过关发放的机体零件奖励；giftUnit：过关发放的机体奖励
		// 序章1（ID1/ID2）：关卡奖励 + 我方独角兽（ID 264）的 4 个零件槽
		stage0_1: {
			giftPart,
			giftUnit,
			unicornParts: prologue1
		},
		// 序章2（ID7/ID8）：我方独角兽（ID 264）的 4 个零件槽
		stage0_2: {
			unicornParts: prologue2
		},
		// 第一话（ID19/ID20）：过关发放的零件 / 机体奖励
		stage1: {
			giftPart: stage1.giftPart,
			giftUnit: stage1.giftUnit
		}
	};
}

/**
 * @param {{ filePath?: string, fileName?: string, fileSrc?: string }} ctx 主进程注入的上下文
 */
module.exports = function (ctx = {}) {
	// 目标文件名来自 config.json -> loadFiles[key].fileName
	const targetName = ctx.fileName || DEFAULT_TARGET_NAME;
	let target;
	try {
		// 1) 拿到 filePath 后查找文件，确保只有唯一一个
		target = findFile(ctx.filePath, targetName);
	} catch {
		throw new Error(`请重新选择正确的游戏目录，里面应该只包含一个${targetName}文件`);
	}
	// 2) 把找到的文件地址赋值给 fileSrc
	ctx.fileSrc = target;
	// 3) 执行加载方法，传入 fileSrc 读取文件
	return loadFile(ctx);
};

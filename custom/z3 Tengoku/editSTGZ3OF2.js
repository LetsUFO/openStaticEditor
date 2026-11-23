/**
 * STGZ3OF2.SDAT 保存脚本（第一阶段：结构级重打包，不做压缩）
 *
 * 执行流程：
 *   1. 读取 ctx.filePath（关卡文件绝对路径）
 *   2. NPD/EDAT v4 → 解密出明文 CPK（若已经是明文 CPK 则直接使用）
 *   3. 按 ItocL / ItocH 的 ID 顺序依次取出每个文件
 *      - 以 CRILAYLA 开头的走解压，其余视为原始数据
 *   4. 按原文件的排版规则（ContentOffset 起、每条按 16 字节对齐）重新拼装内容区
 *   5. 回填 CpkHeader（ContentSize / EnabledPackedSize / EnabledDataSize）
 *      与 ItocL / ItocH 每条记录的 FileSize（改为未压缩长度）
 *   6. 以明文 CPK 覆盖写回原路径
 *
 * 注意：本阶段只保证“解密 → 解包 → 重新打包”的流程正确，
 *       尚未接入表单数据（giftPart 等）的写入，也暂不重新进行 CRILAYLA 压缩，
 *       因此写回的文件不再是 EDAT，游戏暂时无法直接读取。
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

/**
 * 重新打包明文 CPK（不压缩），返回新的 Buffer
 * @param {Buffer} plain 明文 CPK
 */
function repackCpk(plain) {
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
			entries.push({ table: t, idx, id: row.ID, fileSize: row.FileSize, extractSize: row.ExtractSi ?? row.ExtractSize });
		});
	}
	entries.sort((a, b) => a.id - b.id);
	if (entries.length !== hdr.Files) {
		throw new Error(`条目数量异常：表内 ${entries.length}，头部 ${hdr.Files}`);
	}

	// 逐条取出原始数据（CRILAYLA 解压，其余原样）
	// srcCursor 走原文件里的压缩数据，pos 走新内容区的未压缩数据
	let srcCursor = contentOffset;
	let pos = 0;
	let rawTotal = 0;
	for (const e of entries) {
		srcCursor = Math.ceil(srcCursor / align) * align;
		const comp = plain.subarray(srcCursor, srcCursor + e.fileSize);
		const raw = comp.toString('latin1', 0, 8) === 'CRILAYLA' ? decompressCrilayla(comp) : comp;
		if (raw.length !== e.extractSize) {
			throw new Error(`文件 ${e.id} 长度不符：解出 ${raw.length}，表内 ${e.extractSize}`);
		}
		e.raw = raw;
		e.at = Math.ceil(pos / align) * align;
		pos = e.at + raw.length;
		rawTotal += raw.length;
		srcCursor += e.fileSize;
	}

	// 拼内容区：每条按 align 对齐，末尾补零到 align
	const contentSize = Math.ceil(pos / align) * align;
	const content = Buffer.alloc(contentSize);
	for (const e of entries) e.raw.copy(content, e.at);

	// 回填头部字段
	header.setField(0, 'ContentSize', contentSize);
	header.setField(0, 'EnabledPackedSize', rawTotal);
	header.setField(0, 'EnabledDataSize', rawTotal);

	// 回填每条记录的文件长度
	for (const e of entries) {
		e.table.setField(e.idx, 'FileSize', e.raw.length);
	}

	return Buffer.concat([plain.subarray(0, contentOffset), content]);
}

/**
 * @param {{ filePath?: string, dataKey?: string, data?: any }} ctx 主进程注入的上下文
 */
module.exports = function (ctx = {}) {
	const filePath = ctx.filePath || (ctx.data && ctx.data.fileSrc) || '';
	if (!filePath) throw new Error('缺少关卡文件路径（ctx.filePath 为空），请重新加载 STGZ3OF2.SDAT');

	const plain = loadPlainCpk(filePath);
	const packed = repackCpk(plain);
	fs.writeFileSync(filePath, packed);

	console.log(`[editSTGZ3OF2] ${filePath} 已写回：${plain.length} → ${packed.length} 字节（明文 CPK）`);
	return { fileSrc: filePath, size: packed.length };
};

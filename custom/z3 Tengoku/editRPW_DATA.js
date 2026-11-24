'use strict';
/**
 * 第3次超级机器人大战Z：天狱篇 —— RPW_DATA.CPK 保存脚本
 *
 * 由主进程 script:run 调用（config.json -> menu[强化零件].saveScript）。
 *
 * 执行流程：
 *   1. 读取 ctx.filePath（RPW_DATA.CPK 绝对路径，来自 store.filePaths.RPW_DATA）
 *   2. 解析 CPK 内的 CpkHeader / CpkItocH，定位 ID=0 文件的内容区
 *   3. 取出内容区的 CRILAYLA 压缩块并解压，得到 <mt> 容器（含 boost-p 零件表）
 *   4. 按 ctx.data.partData 把每个零件的 31 个参数字段写回对应的 84 字节记录
 *      （partData 由 readRpwData.js 的 compactPart 精简而来：值为 0 的字段被省略，
 *        写回时缺失字段一律写 0，与原值一致）
 *   5. 用内置的 CRILAYLA 压缩器把修改后的 <mt> 数据重新压缩
 *   6. 按 Align 对齐重新拼装内容区，回填 CpkItocH 的 FileSize / ExtractSize
 *      与 CpkHeader 的 ContentSize / EnabledPackedSize / EnabledDataSize
 *   7. 以压缩后的 CPK 覆盖写回原路径
 *
 * 返回：{ fileSrc, size }，与 readRpwData.js 的返回结构对齐。
 */

const fs = require('node:fs');

// 零件表布局常量（与 readRpwData.js 保持一致）
const PART_RECORD_SIZE = 84;
const PART_COUNT = 78;

/* ------------------------------------------------------------------ */
/* 零件字段写入表：与 readRpwData.js 的 readPartParams 字段一一对应     */
/* [store 键, 类型, 记录内偏移]                                        */
/* ------------------------------------------------------------------ */
const PART_FIELDS = [
	['damageRate', 'u16', 40],
	['reserved', 'u16', 42],
	['attack', 'u16', 44],
	['willReq', 'u16', 46],
	['hp', 'u16', 48],
	['en', 'u16', 50],
	['armor', 'u16', 52],
	['price', 'u16', 54],
	['category', 'u8', 56],
	['move', 'u8', 57],
	['mobility', 'u8', 58],
	['accuracy', 'u8', 59],
	['afterimageRate', 'u8', 60],
	['hpRecover', 'u8', 61],
	['enRecover', 'u8', 62],
	['ammoRecover', 'u8', 63],
	['moveType', 'u8', 64],
	['terrainAdapt', 'u8', 65],
	['barrier', 'u8', 66],
	['specialAbility', 'u8', 67],
	['crit', 'u8', 68],
	['range', 'u8', 69],
	['rangeApply', 'u8', 70],
	['sizeIgnore', 'u8', 71],
	['sortieWill', 'u8', 72],
	['sortieSpFull', 'u8', 73],
	['rewardRate', 'u8', 74],
	['passive', 'u8', 75],
	['itemEffect', 'u8', 76],
	['spRecover', 'u8', 77],
	['itemSpecial', 'u8', 78],
	['procRate', 'u8', 79],
	['effectGroup', 'u8', 80]
];

/**
 * 把一个零件的所有字段按偏移写回 84 字节记录。
 * 缺失字段（compactPart 精简掉的 0 值字段）一律写 0，与原值一致。
 * @param {Buffer} rec 84 字节记录（subarray 视图，写操作直接落到原 buffer）
 * @param {Record<string, any>} part 单个零件数据
 * @param {number} id 零件 ID（仅用于错误信息）
 */
function writePartParams(rec, part, id) {
	for (const [key, type, offset] of PART_FIELDS) {
		const raw = part[key];
		const value = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
		if (!Number.isFinite(value) || !Number.isInteger(value)) {
			throw new Error(`零件 ${id} 的 ${key} 不是整数：${raw}`);
		}
		if (type === 'u16') {
			if (value < 0 || value > 0xffff) {
				throw new Error(`零件 ${id} 的 ${key} 超出 u16 范围：${value}`);
			}
			rec.writeUInt16LE(value, offset);
		} else {
			if (value < 0 || value > 0xff) {
				throw new Error(`零件 ${id} 的 ${key} 超出 u8 范围：${value}`);
			}
			rec.writeUInt8(value, offset);
		}
	}
}

/* ------------------------------------------------------------------ */
/* CRILAYLA 解压（与 readRpwData.js 完全一致）                          */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* CRILAYLA 压缩（decompressCrilayla 的逆运算）                         */
/* 输出布局：                                                          */
/*   [0..8)    'CRILAYLA'                                              */
/*   [8..12)   u32 LE usize（解压后长度，不含 0x100 字典前缀）         */
/*   [12..16)  u32 LE 位流长度 = hoff（字典前缀偏移 = hoff + 0x10）    */
/*   [16..16+streamLen)        压缩位流（反向存储，高位优先）          */
/*   [16+streamLen..+0x100)    字典前缀（原始数据前 0x100 字节）       */
/* ------------------------------------------------------------------ */
function compressCrilayla(data) {
	if (data.length <= 0x100) throw new Error('CRILAYLA 压缩：输入数据过短');
	const usize = data.length - 0x100;
	const prefix = data.subarray(0, 0x100);
	const end = data.length - 1; // 待编码数据末尾的下标（含 0x100 前缀坐标系）

	// --- 后向位写入器：与解压端 bits(k) 镜像 ---
	// 先写的位 → 高地址字节的高位；后写的位 → 同字节低位 / 更低地址字节。
	let buf = Buffer.alloc(Math.max(4096, usize + 1024));
	let pos = buf.length;
	let bitPos = 0;
	const ensureCap = () => {
		if (pos > 16) return;
		const next = Buffer.alloc(buf.length * 2);
		buf.copy(next, next.length - (buf.length - pos), pos);
		pos = next.length - (buf.length - pos);
		buf = next;
	};
	const writeBit = (b) => {
		if (bitPos === 0) {
			ensureCap();
			pos--;
			buf[pos] = 0;
		}
		if (b) buf[pos] |= 1 << (7 - bitPos);
		bitPos = (bitPos + 1) & 7;
	};
	const writeBits = (v, k) => {
		for (let i = k - 1; i >= 0; i--) writeBit((v >>> i) & 1);
	};

	// --- 匹配查找：反向 3 字节哈希 + 哈希链 ---
	// 解压匹配是 out[end-done-i] = out[ref-i]，源和目标都向低地址方向读取，
	// 所以哈希键取 data[p], data[p-1], data[p-2]。
	const HASH_BITS = 16;
	const HASH_SIZE = 1 << HASH_BITS;
	const hashHead = new Int32Array(HASH_SIZE).fill(-1);
	const hashPrev = new Int32Array(data.length).fill(-1);
	const hash3 = (p) =>
		(((data[p] << 16) ^ (data[p - 1] << 8) ^ data[p - 2]) * 0x9e3779b1) >>> (32 - HASH_BITS);

	let done = 0;
	while (done < usize) {
		const outPos = end - done; // 当前要编码的字节位置
		let bestLen = 0;
		let bestDist = 0;
		// ref = outPos + dist + 3 必须 ≤ end（不能引用未解码区域），故 dist ≤ done - 3
		const maxDist = Math.min(8191, done - 3);
		// 写入不能越过 0x100 边界（不能编码字典前缀区域）
		const maxLen = Math.min(outPos - 0x100 + 1, 65536);

		if (maxDist >= 0 && outPos >= 0x100 + 2) {
			const h = hash3(outPos);
			let ref = hashHead[h];
			let chain = 0;
			while (ref >= 0 && chain < 64) {
				const dist = ref - outPos - 3;
				if (dist < 0) break; // 哈希链按位置降序，后续都更近
				if (dist <= maxDist) {
					let len = 0;
					while (len < maxLen && data[ref - len] === data[outPos - len]) len++;
					if (len > bestLen) {
						bestLen = len;
						bestDist = dist;
						if (len >= 64) break; // 提前退出，避免过长搜索
					}
				}
				ref = hashPrev[ref];
				chain++;
			}
		}

		if (bestLen >= 3) {
			// match token: 1 + 13bit dist + 变长 len
			writeBit(1);
			writeBits(bestDist, 13);
			let remain = bestLen - 3;
			let full = true;
			for (const w of [2, 3, 5, 8]) {
				const max = (1 << w) - 1;
				if (remain < max) {
					writeBits(remain, w);
					full = false;
					break;
				}
				writeBits(max, w);
				remain -= max;
			}
			if (full) {
				while (remain >= 255) {
					writeBits(255, 8);
					remain -= 255;
				}
				writeBits(remain, 8);
			}
		} else {
			// literal token: 0 + 8bit 字节
			writeBit(0);
			writeBits(data[outPos], 8);
		}

		// 把本次编码覆盖的位置全部加入哈希表
		const encLen = bestLen >= 3 ? bestLen : 1;
		for (let i = 0; i < encLen; i++) {
			const p = outPos - i;
			if (p >= 0x100 + 2) {
				const h = hash3(p);
				hashPrev[p] = hashHead[h];
				hashHead[h] = p;
			}
		}
		done += encLen;
	}

	const streamStart = pos;
	const streamLen = buf.length - streamStart;
	const total = 16 + streamLen + 0x100;
	const result = Buffer.alloc(total);
	result.write('CRILAYLA', 0, 'latin1');
	result.writeUInt32LE(usize, 8);
	result.writeUInt32LE(streamLen, 12);
	// buf 中先写入的在高地址，对应压缩位流的"开头"（解压端 pos 由高向低读），
	// 拷贝时让高地址字节落到 result 高地址，顺序保持一致。
	buf.copy(result, 16, streamStart);
	prefix.copy(result, 16 + streamLen);
	return result;
}

/* ------------------------------------------------------------------ */
/* CPK / UTF 表（与 editSTGZ3OF2.js 相同的精简实现）                    */
/* ------------------------------------------------------------------ */
const TSZ = [1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 4, 8];
const TFM = [
	'readUInt8', 'readInt8', 'readUInt16BE', 'readInt16BE',
	'readUInt32BE', 'readInt32BE', 'readBigUInt64BE', 'readBigInt64BE',
	'readFloatBE', 'readDoubleBE'
];
const be16 = (b, o) => b.readUInt16BE(o);
const be32 = (b, o) => b.readUInt32BE(o);

class UTFTable {
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
	setField(rowIndex, name, value) {
		const c = this.layout.find((it) => it.name === name);
		if (!c) throw new Error(`表 ${this.name} 缺少行内字段 ${name}`);
		const p = this.rowsBase + rowIndex * this.stride + c.at;
		if (c.sz === 8) {
			this.buf.writeBigUInt64BE(BigInt(value), p);
			return;
		}
		if (c.sz === 4) {
			this.buf.writeUInt32BE(value >>> 0, p);
			return;
		}
		if (c.sz === 2) {
			if (value > 0xffff) throw new Error(`${this.name}.${name} 超出 u16 范围：${value}`);
			this.buf.writeUInt16BE(value, p);
			return;
		}
		if (value > 0xff) throw new Error(`${this.name}.${name} 超出 u8 范围：${value}`);
		this.buf.writeUInt8(value, p);
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

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {{ filePath?: string, dataKey?: string, data?: any }} ctx 主进程注入的上下文
 *   ctx.filePath  RPW_DATA.CPK 的绝对路径（store.filePaths.RPW_DATA）
 *   ctx.data      表单完整数据（含 partData / partList / fileSrc 等）
 */
module.exports = function (ctx = {}) {
	const filePath = ctx.filePath || (ctx.data && ctx.data.fileSrc) || '';
	if (!filePath) throw new Error('缺少 RPW_DATA.CPK 路径（ctx.filePath 为空），请重新加载 RPW_DATA.CPK');

	const partData = ctx.data && ctx.data.partData;
	if (!partData || typeof partData !== 'object') {
		throw new Error('缺少 partData，表单数据格式异常');
	}

	const raw = fs.readFileSync(filePath);
	if (raw.toString('latin1', 0, 4) !== 'CPK ') {
		throw new Error(`文件格式不符：不是 CPK（${filePath}）`);
	}

	// 1) 解析 UTF 表，定位 CpkHeader / CpkItocH 与内容区
	const tables = findAllUtfs(raw).map(([off]) => new UTFTable(raw, off));
	const header = tables.find((t) => t.name === 'CpkHeader');
	const itocH = tables.find((t) => t.name === 'CpkItocH');
	if (!header || !header.nrows) throw new Error('CPK 内缺少 CpkHeader');
	if (!itocH || !itocH.nrows) throw new Error('CPK 内缺少 CpkItocH 记录');

	const hdr = header.rows()[0];
	const contentOffset = hdr.ContentOffset;
	const align = hdr.Align || 16;
	if (!contentOffset) throw new Error('CpkHeader 缺少 ContentOffset');
	if (hdr.Files !== 1) throw new Error(`RPW_DATA.CPK 应仅含 1 个文件，实际 ${hdr.Files}`);

	const itocRow = itocH.rows()[0];
	if (itocRow.ID !== 0) throw new Error(`CpkItocH 首行 ID 应为 0，实际 ${itocRow.ID}`);

	// 2) 取出 CRILAYLA 压缩块并解压
	const compBlock = raw.subarray(contentOffset, contentOffset + itocRow.FileSize);
	const decoded = decompressCrilayla(compBlock);
	if (decoded.length !== itocRow.ExtractSize) {
		throw new Error(`解压长度异常：解出 ${decoded.length}，表内 ${itocRow.ExtractSize}`);
	}

	// 3) 定位 boost-p 零件表并按 ID 建索引
	const nameAt = decoded.indexOf('boost-p\0');
	if (nameAt < 0) throw new Error('文件格式不符：找不到 boost-p 零件表');
	const tableLen = decoded.readUInt32LE(nameAt + 12);
	const tableStart = nameAt + 16;
	if (tableLen < (PART_COUNT + 1) * PART_RECORD_SIZE) {
		throw new Error('文件格式不符：boost-p 零件表长度异常');
	}
	const recordById = new Map();
	for (let r = 1; r <= PART_COUNT; r++) {
		const off = tableStart + r * PART_RECORD_SIZE;
		const rec = decoded.subarray(off, off + PART_RECORD_SIZE);
		const id = rec.readUInt32LE(36);
		if (id < 1 || id > PART_COUNT) continue;
		recordById.set(id, rec);
	}

	// 4) 把 partData 中每个零件的字段写回记录
	let updated = 0;
	for (const [idStr, part] of Object.entries(partData)) {
		const id = Number(idStr);
		if (!Number.isInteger(id) || id < 1 || id > PART_COUNT) continue;
		const rec = recordById.get(id);
		if (!rec) continue;
		writePartParams(rec, part, id);
		updated++;
	}
	if (!updated) throw new Error('没有任何零件被写回，partData 可能为空');

	// 5) 重新 CRILAYLA 压缩
	const compressed = compressCrilayla(decoded);

	// 6) 拼装新内容区：直接使用压缩块，不追加对齐填充
	//    CRILAYLA 解压端按 block 末尾（block.length - 0x100 - 1）定位比特流起点，
	//    若在压缩块后补零对齐，会让读取位置错位、破坏整个解压（游戏与本工具均受影响）。
	//    原文件本身也未填充到 ContentSize（实际内容区长度 == FileSize），故保持紧凑布局。
	const newFileSize = compressed.length;
	const newContentSize = Math.ceil(newFileSize / align) * align; // 仅用于 CpkHeader.ContentSize，与原文件一致
	const content = compressed;

	// 7) 回填 CpkItocH 与 CpkHeader（FileSize / TotalDataSize 是常量列，不在行内，跳过）
	itocH.setField(0, 'FileSize', newFileSize);
	itocH.setField(0, 'ExtractSize', decoded.length);
	header.setField(0, 'ContentSize', newContentSize);
	header.setField(0, 'EnabledPackedSize', decoded.length);
	header.setField(0, 'EnabledDataSize', newFileSize);

	// 8) 覆盖写回原文件
	const packed = Buffer.concat([raw.subarray(0, contentOffset), content]);
	fs.writeFileSync(filePath, packed);

	console.log(
		`[editRPW_DATA] ${filePath} 已写回：零件 ${updated} 个，` +
			`压缩块 ${itocRow.FileSize} → ${newFileSize} 字节，` +
			`文件 ${raw.length} → ${packed.length} 字节`
	);
	return { fileSrc: filePath, size: packed.length };
};
